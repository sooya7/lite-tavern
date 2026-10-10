// 酒馆 public/script.js 的兼容模块：给按酒馆路径 import 的第三方插件用（见 js/ui/extensions.js）。
// 只导出插件常用的函数；聊天、角色之类会变的数据请用 SillyTavern.getContext() 取。
import { stHost, installStGlobals } from './js/ui/extensions.js';

installStGlobals();

export const eventSource = stHost.eventSource;
export const event_types = stHost.event_types;
export const saveSettings = () => stHost.saveSettings();
export const saveSettingsDebounced = () => stHost.saveSettingsDebounced();
export const saveChat = () => stHost.saveChat();
export const saveChatConditional = () => stHost.saveChatConditional();
export const saveChatDebounced = () => stHost.saveChatDebounced();
export const saveMetadata = () => stHost.saveMetadata();
export const saveMetadataDebounced = () => stHost.saveMetadataDebounced();
export const getRequestHeaders = () => stHost.getRequestHeaders();
export const getContext = () => stHost.getContext();
export const substituteParams = (text) => stHost.getContext().substituteParams(text);
export const substituteParamsExtended = (text) => stHost.getContext().substituteParams(text);
export const getCurrentChatId = () => stHost.getContext().getCurrentChatId();
export const getTokenCountAsync = (text) => stHost.getContext().getTokenCountAsync(text);
export const generateQuietPrompt = (...a) => stHost.getContext().generateQuietPrompt(...a);
export const generateRaw = (...a) => stHost.getContext().generateRaw(...a);
export const callPopup = (...a) => stHost.getContext().callPopup(...a);
export const reloadCurrentChat = () => stHost.getContext().reloadCurrentChat();
export const updateMessageBlock = (id) => stHost.getContext().updateMessageBlock(id);
export const messageFormatting = (...a) => stHost.getContext().messageFormatting(...a);
export const stopGeneration = () => stHost.getContext().stopGeneration();
export const extension_prompt_types = { NONE: -1, IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 };
export const extension_prompt_roles = { SYSTEM: 0, USER: 1, ASSISTANT: 2 };
