#!/usr/bin/env bash
# 轻酒馆 + Luker 用户数据 → Google Drive 的每日异地备份。
# 装在 /usr/local/sbin/lite-tavern-gdrive-backup.sh，由 lite-tavern-gdrive-backup.timer 触发。
# 备份里有连接的 Key（两边的 secrets.json）和全部聊天，本地目录和归档都是仅 root 可读。
set -euo pipefail

LT_DATA="${LT_DATA:-/opt/lite-tavern/data}"
ST_DATA="${ST_DATA:-/opt/luker/data/admin}"
LOCAL_DIR="${LT_BACKUP_LOCAL_DIR:-/opt/lite-tavern/backups-cloud}"
LOCAL_KEEP="${LT_BACKUP_LOCAL_KEEP:-3}"
REMOTE_ROOT="${LT_BACKUP_REMOTE:-gdrive:SOOYA/lite-tavern-backups}"
REMOTE_KEEP="${LT_BACKUP_REMOTE_KEEP:-30}"
RCLONE_CONFIG="${LT_BACKUP_RCLONE_CONFIG:-/root/.config/rclone/rclone.conf}"
PING_URL="${LT_PING_URL:-http://127.0.0.1:8730/api/ping}"
# 出口代理时好时坏（节点自动切换），rclone 的每一步都整体重试
TRIES="${LT_BACKUP_TRIES:-40}"
TRY_SLEEP="${LT_BACKUP_TRY_SLEEP:-20}"
PREFIX="lite-tavern-backup-"

log() { echo "[lt-backup] $*"; }
die() { echo "[lt-backup] 失败：$*" >&2; exit 1; }

command -v rclone >/dev/null 2>&1 || die "没有 rclone"
[[ -f "$RCLONE_CONFIG" ]] || die "找不到 rclone 配置 $RCLONE_CONFIG"
[[ -d "$LT_DATA" ]] || die "找不到轻酒馆数据目录 $LT_DATA"
[[ "$LOCAL_KEEP" =~ ^[1-9][0-9]*$ && "$REMOTE_KEEP" =~ ^[1-9][0-9]*$ ]] || die "保留份数必须是正整数"
# 代理坏的时候连接会挂着不动：连不上 20 秒、没数据 2 分钟就放弃这一次，交给外面的重试。
# --drive-upload-cutoff 1G：归档用一次请求传完，不分块。这个 rclone 远端用的是 rclone 自带的公共 client_id，
# Google 按分钟限流（403 Quota exceeded）；分块上传时限流正好卡在最后一块的提交上，重试 10 次不过就整份重传，
# 一百多 MB 怎么也传不完。一次请求的话限流只发生在开头，等几秒重试，放行后就能一口气传完。
RCLONE=(rclone --config "$RCLONE_CONFIG" --contimeout 20s --timeout 2m --drive-upload-cutoff 1G)

retry() {
  local n=1
  until "$@"; do
    (( n >= TRIES )) && return 1
    log "第 $n 次没成功，${TRY_SLEEP} 秒后重试（rclone ${10:-}）"
    sleep "$TRY_SLEEP"
    n=$((n + 1))
  done
}

umask 077
mkdir -p "$LOCAL_DIR"
chmod 700 "$LOCAL_DIR"

LT_DATA="${LT_DATA%/}"; ST_DATA="${ST_DATA%/}"
LT_NAME="$(basename "$LT_DATA")"
ST_NAME="$(basename "$ST_DATA")"
[[ "$LT_NAME" != "$ST_NAME" ]] || die "两个数据目录同名（$LT_NAME），归档里分不开"

# 归档里两棵树：lite-tavern-data/（轻酒馆自己的设置、密钥等）和 st-data/（酒馆用户目录）。
# 排除规则按原始路径、从开头匹配。
TAR_ARGS=(--warning=no-file-changed --warning=no-file-removed --anchored
  --exclude="$LT_NAME/_cache"
  --transform "s#^$LT_NAME#lite-tavern-data#S")

# 共用模式下轻酒馆自己目录里的角色卡 / 聊天 / 世界书 / 预设是切换前留下的旧副本，
# 真正在用的那份在酒馆目录里（下面会备份），旧副本就不带了。问不到服务就全带上。
if curl -fsS -m 5 "$PING_URL" 2>/dev/null | grep -q '"shared":"'; then
  for d in characters chats worlds presets; do TAR_ARGS+=(--exclude="$LT_NAME/$d"); done
  log "共用模式：跳过轻酒馆目录里的旧副本"
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BASE="${PREFIX}${STAMP}.tar.gz"
ARCHIVE="$LOCAL_DIR/$BASE"
TMP="$ARCHIVE.part"
trap 'rm -f "$TMP"' EXIT

TAR_SRC=(-C "$(dirname "$LT_DATA")" "$LT_NAME")
if [[ -d "$ST_DATA" ]]; then
  # 酒馆目录里不带的：backups（酒馆自己的滚动备份，八百多 MB）、extensions（插件代码，可重装；
  # 插件的设置在 settings.json 里）、thumbnails（缩略图缓存）。
  TAR_ARGS+=(--exclude="$ST_NAME/backups" --exclude="$ST_NAME/extensions" --exclude="$ST_NAME/thumbnails"
    --transform "s#^$ST_NAME#st-data#S")
  TAR_SRC+=(-C "$(dirname "$ST_DATA")" "$ST_NAME")
else
  log "没有酒馆数据目录 $ST_DATA，只备份轻酒馆自己的"
fi
TAR_ARGS+=(-czf "$TMP" "${TAR_SRC[@]}")

log "打包"
rc=0
tar "${TAR_ARGS[@]}" || rc=$?
# 1 = 打包途中有文件被改写（服务在跑，正常）；更大的才是真出错
(( rc <= 1 )) || die "tar 退出码 $rc"

gzip -t "$TMP" || die "归档损坏"
COUNT="$(tar -tzf "$TMP" | wc -l)"
(( COUNT > 20 )) || die "归档里只有 $COUNT 个条目，不对劲"
# 抽一个文件出来确认归档真的能解；内容不是合法 JSON 只提醒（照样备份，聊天和角色卡还在里面）
SETTINGS_BYTES="$(tar -xzOf "$TMP" lite-tavern-data/settings.json | wc -c)" || die "归档解不开"
(( SETTINGS_BYTES > 0 )) || die "归档里没有 settings.json"
tar -xzOf "$TMP" lite-tavern-data/settings.json | python3 -c 'import json,sys; json.load(sys.stdin)' 2>/dev/null \
  || log "注意：settings.json 不是合法 JSON（可能正好在写入），这份备份照常保留"
mv "$TMP" "$ARCHIVE"
( cd "$LOCAL_DIR" && sha256sum "$BASE" > "$BASE.sha256" )
log "本地归档：$BASE，$(du -h "$ARCHIVE" | cut -f1)，$COUNT 个条目"

# 本地只留最近几份；不管后面上传成不成都清，免得连着失败把盘占满
mapfile -t OLD_LOCAL < <(ls -1 "$LOCAL_DIR"/${PREFIX}*.tar.gz 2>/dev/null | sort -r | tail -n +$((LOCAL_KEEP + 1)))
for old in "${OLD_LOCAL[@]:-}"; do
  [[ -z "$old" ]] && continue
  rm -f "$old" "$old.sha256"
done

log "上传到 $REMOTE_ROOT"
retry "${RCLONE[@]}" mkdir "$REMOTE_ROOT" || die "连不上 Google Drive"
retry "${RCLONE[@]}" copyto "$ARCHIVE" "$REMOTE_ROOT/$BASE" --retries 2 --low-level-retries 20 \
  || die "上传失败（本地归档留在 $ARCHIVE）"
retry "${RCLONE[@]}" copyto "$ARCHIVE.sha256" "$REMOTE_ROOT/$BASE.sha256" --retries 3 --low-level-retries 10 \
  || die "校验文件上传失败"

log "核对云端的文件"
retry "${RCLONE[@]}" check "$LOCAL_DIR" "$REMOTE_ROOT" --one-way \
  --include "$BASE" --include "$BASE.sha256" --checkers 2 >/dev/null 2>&1 \
  || die "云端文件和本地对不上"

# 只有这次传上去并核对过，才清理旧的
mapfile -t OLD_REMOTE < <(
  "${RCLONE[@]}" lsf "$REMOTE_ROOT" --files-only --include "${PREFIX}*.tar.gz" 2>/dev/null \
    | sort -r | tail -n +$((REMOTE_KEEP + 1))
)
for old in "${OLD_REMOTE[@]:-}"; do
  [[ -z "$old" ]] && continue
  log "删掉云端旧备份 $old"
  "${RCLONE[@]}" deletefile "$REMOTE_ROOT/$old" || true
  "${RCLONE[@]}" deletefile "$REMOTE_ROOT/$old.sha256" 2>/dev/null || true
done

log "完成：$REMOTE_ROOT/$BASE"
