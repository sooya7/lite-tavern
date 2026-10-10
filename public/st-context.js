// 酒馆 public/scripts/st-context.js 的兼容模块（插件里写的是 ../../../../st-context.js，落到这里）
import { stHost, installStGlobals } from './js/ui/extensions.js';

installStGlobals();
export const getContext = () => stHost.getContext();
export default getContext;
