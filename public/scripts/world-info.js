// 酒馆 public/scripts/world-info.js 的兼容模块：插件读写世界书用（见 js/ui/extensions.js）
import { stHost, installStGlobals } from '../js/ui/extensions.js';

installStGlobals();

export const loadWorldInfo = (name) => stHost.loadWorldInfo(name);
export const saveWorldInfo = (name, data) => stHost.saveWorldInfo(name, data);
export const getWorldInfo = (name) => stHost.loadWorldInfo(name);
/** 世界书名字列表：是个快照，需要最新的请再 import 一次或用 window.world_names */
export const world_names = stHost.world_names;
export const selected_world_info = stHost.selected_world_info;
export const world_info = { globalSelect: stHost.selected_world_info };
export const world_info_position = { before: 0, after: 1, ANTop: 2, ANBottom: 3, atDepth: 4, EMTop: 5, EMBottom: 6 };
