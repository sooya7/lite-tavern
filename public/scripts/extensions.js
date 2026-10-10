// 酒馆 public/scripts/extensions.js 的兼容模块（见 js/ui/extensions.js）
import { stHost, installStGlobals } from '../js/ui/extensions.js';

installStGlobals();

/** 和轻酒馆设置里的 extensions 是同一个对象，改了之后调 saveSettingsDebounced() 保存 */
export const extension_settings = stHost.extension_settings;
export const getContext = () => stHost.getContext();
export const saveMetadataDebounced = () => stHost.saveMetadataDebounced();
export const extensionNames = [];
export const modules = [];
export async function renderExtensionTemplateAsync() { return ''; }
export function renderExtensionTemplate() { return ''; }
export async function writeExtensionField(characterId, key, value) { return stHost.getContext().writeExtensionField(characterId, key, value); }
export function doExtrasFetch(...a) { return fetch(...a); }
export function getApiUrl() { return ''; }
