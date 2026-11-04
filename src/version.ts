/**
 * 合流版本号，唯一来源是 package.json。
 * 看板在 /api/projects 里报出来；`heliu board` 撞上已在运行的看板时据此判断它是不是旧版。
 */
import pkg from "../package.json";

export const VERSION: string = pkg.version;
