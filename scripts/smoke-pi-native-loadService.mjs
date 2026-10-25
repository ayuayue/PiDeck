// 经 loadTsCommonJs 加载生产 TS 模块（PiResourceConfigService 及其依赖为纯 Node）。
import { loadTsCommonJs } from "/home/zhadainian/PiDeck/tests/helpers/loadTsCommonJs.mjs";
export const { PiResourceConfigService } = loadTsCommonJs("src/main/config/PiResourceConfigService.ts");
