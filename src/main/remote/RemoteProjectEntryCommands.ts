import { posix } from "node:path";
import type { RemoteEntryKind, RemoteEntryRevision } from "../../shared/types/remoteFiles";
import { quotePosixArgument } from "./RemoteBootstrapContract";
import { BOUNDARY_SCRIPT } from "./RemoteProjectFileCommands";
import { readCanonicalBrowseRoot } from "./RemoteBrowseRoot";
import { REMOTE_HELPER_MAX_REMOTE_COMMAND_LENGTH } from "./RemoteHelperContract";

/**
 * 远端文件管理（Phase 5 文件面）的命令构造与 main 侧输入边界。
 *
 * 设计约束（冻结在 docs/archive/remote/remote-file-management-plan.md §2.3/§3.4/§4/§8）：
 * - **不新增 helper op**：所有写操作是 main 构造的一次性 Node 标准库脚本，经既有 pinned SSH 执行；
 * - **边界只有一份实现**：脚本前缀直接拼接 RemoteProjectFileCommands 的 BOUNDARY_SCRIPT（canonical root
 *   重证 + 父链逐级非链接 + /proc/self/fd 锚定），本文件不复制那套判据；
 * - **越界输入在构造命令前拒绝**（IPC 边界与这里各一次），命令长度 <=8192、单脚本压平 <=5120 由测试钉住。
 *   为满足该预算，回收站三个管理动作各自成脚本（冻结文本里的一项 TRASH_ADMIN_SCRIPT 拆为
 *   list/restore/prune 三份，语义与命令数不变；这是实现期唯一的结构性预算拆分，见赛道报告）。
 */

/** 项目根下的回收站目录名（对用户/Git 可见的一条未跟踪目录，列表/搜索隐藏，读/写拒绝）。 */
export const REMOTE_PROJECT_TRASH_DIR = ".pideck-trash";
/** main 生成的回收站条目 id：UTC 时间戳 + 8 hex；同时是 .pideck-trash 下的目录名。 */
export const REMOTE_PROJECT_TRASH_ID = /^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}$/;
export const REMOTE_PROJECT_TRASH_MAX_ENTRIES = 256;
export const REMOTE_PROJECT_TRASH_MAX_IDS = 32;
/** 列表输出上限：超过就丢最旧的条目并标 truncated（列表是唯一允许截断的地方）。 */
export const REMOTE_PROJECT_TRASH_LIST_MAX_OUTPUT = 64 * 1024;
export const REMOTE_PROJECT_TRASH_MANIFEST_MAX_BYTES = 8 * 1024;
/** 压平后的脚本长度上限：给 Node 绝对路径 + root + 1~2 个相对路径 + JSON 参数留下 >=3072 字符。 */
export const REMOTE_PROJECT_ENTRY_SCRIPT_MAX_CHARS = 5120;
/**
 * 回收站 restore/prune 脚本的预算例外（Lead 已批准）：两者必须携带完整严格 manifest 重验 +
 * fd 锚定 + payload 状态判定，实测 6,0xx（list/entry/put 均 <=5,120）。冻结的 5120 目标保留给其余脚本；
 * 单条远程命令仍由 8192 硬上限在构造时兜底拒绝。见 docs/archive/remote/remote-file-management-plan.md §3.4。
 */
export const REMOTE_PROJECT_TRASH_ADMIN_SCRIPT_MAX_CHARS = 6100;
export const REMOTE_PROJECT_ENTRY_MAX_RELATIVE = 4096;
export const REMOTE_PROJECT_ENTRY_MAX_NAME_BYTES = 255;
/** 正文保存临时文件的形态后缀；新名字不得使用，避免与上传中的私有临时文件混淆。 */
const ENTRY_TEMP_SUFFIX = ".pideck-tmp";
const RESERVED_ROOT_NAMES = new Set([REMOTE_PROJECT_TRASH_DIR, ".git", ".pi"]);
/** 控制字节与反斜杠：项目相对路径/单段名字都不允许，避免第二套路径语法。 */
const CONTROL_BYTES = /[\u0000-\u001f\u007f\\]/;

/**
 * 项目根相对 POSIX 路径（§4.1）：非空、非绝对、<=4096、无控制/反斜杠、无空段/点段。
 * 与文本面的 validateRemoteProjectTextPath 同一判据；文件管理不复用它失败文案，但语义逐条相同。
 */
export function validateRemoteProjectEntryPath(value: unknown): string {
	if (typeof value !== "string" || !value || value.length > REMOTE_PROJECT_ENTRY_MAX_RELATIVE || value.startsWith("/") || CONTROL_BYTES.test(value) || value.split("/").some((segment) => !segment || segment === "." || segment === "..")) throw new Error("REMOTE_FILE_PATH_INVALID");
	return value;
}

/** 同上，但允许空串表示项目根——只有 parentRelativePath 合法。 */
export function validateRemoteProjectParentPath(value: unknown): string {
	if (value === "") return "";
	return validateRemoteProjectEntryPath(value);
}

/** 单段名字（§4.1）：<=255 UTF-8 字节；不是点/点点；不含分隔符/控制字节；不是保留名或临时后缀。 */
export function validateRemoteProjectEntryName(value: unknown): string {
	if (typeof value !== "string" || !value || Buffer.byteLength(value, "utf8") > REMOTE_PROJECT_ENTRY_MAX_NAME_BYTES) throw new Error("REMOTE_FILE_NAME_INVALID");
	if (value === "." || value === ".." || value === REMOTE_PROJECT_TRASH_DIR || value.endsWith(ENTRY_TEMP_SUFFIX)) throw new Error("REMOTE_FILE_NAME_INVALID");
	if (value.includes("/") || CONTROL_BYTES.test(value)) throw new Error("REMOTE_FILE_NAME_INVALID");
	return value;
}

export function validateRemoteProjectTrashId(value: unknown): string {
	if (typeof value !== "string" || !REMOTE_PROJECT_TRASH_ID.test(value)) throw new Error("REMOTE_FILE_INPUT_INVALID");
	return value;
}

/** 第一段是 .pideck-trash 的相对路径：只读列表/搜索隐藏、读/编辑/写拒绝（§4.3）。 */
export function isRemoteProjectTrashPath(relative: string): boolean {
	return relative === REMOTE_PROJECT_TRASH_DIR || relative.startsWith(REMOTE_PROJECT_TRASH_DIR + "/");
}

/** rename/delete 的源路径边界（§4.3）：根不能改/删；回收站（任意层级）、根级 .git/.pi（含后代）受保护。 */
export function assertRemoteProjectEntryMutablePath(relative: string): void {
	// 根自身不可改名/删除：不能只靠调用方先跑 validateRemoteProjectEntryPath —— 新入口一旦把顺序
	// 写反，「根」就会作为操作数落到这里被放行（审计发现该断言对 "" 完全不拦）。
	if (relative === "" || relative.split("/").includes("")) throw new Error("REMOTE_FILE_PROTECTED_PATH");
	const segments = relative.split("/");
	if (segments.includes(REMOTE_PROJECT_TRASH_DIR)) throw new Error("REMOTE_FILE_PROTECTED_PATH");
	if (segments[0] === ".git" || segments[0] === ".pi") throw new Error("REMOTE_FILE_PROTECTED_PATH");
}

/** create 的边界：父路径受保护或新名字落在受保护命名空间 => protected；名字规则另由 name validator 负责。 */
export function assertRemoteProjectEntryCreatable(parent: string, name: string): void {
	if (parent !== "") {
		const parentSegments = parent.split("/");
		if (parentSegments.includes(REMOTE_PROJECT_TRASH_DIR) || parentSegments[0] === ".git" || parentSegments[0] === ".pi") throw new Error("REMOTE_FILE_PROTECTED_PATH");
	}
	if (parent === "" && RESERVED_ROOT_NAMES.has(name)) throw new Error("REMOTE_FILE_PROTECTED_PATH");
}

/** §5.4 的 case-only 判定（纯函数，可离开命令执行单测）。 */
export function isRemoteProjectCaseOnlyRename(source: string, target: string): boolean {
	const sourceParent = posix.dirname(source);
	const targetParent = posix.dirname(target);
	const sourceName = posix.basename(source);
	const targetName = posix.basename(target);
	return sourceParent === targetParent && sourceName !== targetName && sourceName.toLowerCase() === targetName.toLowerCase();
}

/** §5.5 的 lexical 自嵌套判定：只有目录才可能移进自身后代；revision.mode 同时带文件类型位。 */
export function assertRemoteProjectEntryMove(source: string, target: string, kind: RemoteEntryKind): void {
	if (source === target) throw new Error("REMOTE_FILE_INPUT_INVALID");
	if (kind !== "directory") return;
	const targetParent = posix.dirname(target);
	if (targetParent === source || targetParent.startsWith(source + "/")) throw new Error("REMOTE_FILE_MOVE_INTO_SELF");
}

/** 严格读回 entry 身份快照：模式位、大小、十进制 bigint 字符串；形状不对一律视为构造失败。 */
export function readRemoteEntryRevision(value: unknown): RemoteEntryRevision {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("REMOTE_FILE_TRANSFER_INVALID");
	const record = value as Record<string, unknown>;
	const keys = ["mode", "size", "dev", "ino", "uid", "gid", "mtimeNs", "ctimeNs"];
	if (Object.keys(record).length !== keys.length) throw new Error("REMOTE_FILE_TRANSFER_INVALID");
	const mode = record.mode;
	const size = record.size;
	if (!Number.isInteger(mode) || (mode as number) < 0 || (mode as number) > 0o7777) throw new Error("REMOTE_FILE_TRANSFER_INVALID");
	if (!Number.isSafeInteger(size) || (size as number) < 0) throw new Error("REMOTE_FILE_TRANSFER_INVALID");
	const decimal = (field: unknown): string => {
		if (typeof field !== "string" || !/^\d{1,40}$/.test(field)) throw new Error("REMOTE_FILE_TRANSFER_INVALID");
		return field;
	};
	return { mode: mode as number, size: size as number, dev: decimal(record.dev), ino: decimal(record.ino), uid: decimal(record.uid), gid: decimal(record.gid), mtimeNs: decimal(record.mtimeNs), ctimeNs: decimal(record.ctimeNs) };
}

/**
 * 所有新脚本共用的紧凑运行时：边界错误码、错误折叠、inode 身份比较、叶分类。
 * 脚本内容会被 squash 后计入远程命令预算，因此刻意用短标识符与单行实现；解释只留在 TS 侧。
 */
const BASE = String.raw`
function F(c){throw Error(c)}
function M(e,f){const m=e&&e.message||"";return /^REMOTE_[A-Z_]+$/.test(m)?m:e&&(e.code==="EACCES"||e.code==="EPERM")?"REMOTE_FILE_PERMISSION_DENIED":e&&e.code==="EEXIST"?"REMOTE_FILE_TARGET_EXISTS":e&&e.code==="ENOENT"?f:"REMOTE_FILE_COMMAND_FAILED"}
function id(s){return{mode:Number(s.mode&4095n),size:Number(s.size),dev:String(s.dev),ino:String(s.ino),uid:String(s.uid),gid:String(s.gid),mtimeNs:String(s.mtimeNs),ctimeNs:String(s.ctimeNs)}}
function kd(s){return s.isFile()?"file":s.isDirectory()?"directory":"other"}
function sameIdent(s,r){const c=id(s);return c.mode===r.mode&&c.size===r.size&&c.dev===r.dev&&c.ino===r.ino}
`;

/**
 * 每个脚本只声明自己用到的稳定码（错误码字符串是最占预算的部分）：共享 BASE 只放运行时。
 * 这份"按脚本裁剪"是 5120 预算的硬约束；新增码必须同时出现在 REMOTE_FILE_ENTRY_CODES 闭集里。
 */
const E_ENTRY = String.raw`const E={changed:"REMOTE_FILE_CHANGED",target:"REMOTE_FILE_TARGET_EXISTS",rename:"REMOTE_FILE_RENAME_UNSUPPORTED",unconf:"REMOTE_FILE_RESULT_UNCONFIRMED",parent:"REMOTE_FILE_PARENT_NOT_FOUND",notdir:"REMOTE_FILE_PARENT_NOT_DIRECTORY",missing:"REMOTE_FILE_NOT_FOUND",unsup:"REMOTE_FILE_ENTRY_UNSUPPORTED",input:"REMOTE_FILE_INPUT_INVALID"};`;
const E_PUT = String.raw`const E={changed:"REMOTE_FILE_CHANGED",unconf:"REMOTE_FILE_RESULT_UNCONFIRMED",missing:"REMOTE_FILE_NOT_FOUND",unsup:"REMOTE_FILE_ENTRY_UNSUPPORTED",input:"REMOTE_FILE_INPUT_INVALID",trash:"REMOTE_FILE_TRASH_UNAVAILABLE",busy:"REMOTE_FILE_BUSY"};`;
const E_LIST = String.raw`const E={input:"REMOTE_FILE_INPUT_INVALID",trash:"REMOTE_FILE_TRASH_UNAVAILABLE",tnf:"REMOTE_FILE_TRASH_ENTRY_NOT_FOUND",tiv:"REMOTE_FILE_TRASH_ENTRY_INVALID"};`;
const E_ADMIN = String.raw`const E={input:"REMOTE_FILE_INPUT_INVALID",trash:"REMOTE_FILE_TRASH_UNAVAILABLE",tnf:"REMOTE_FILE_TRASH_ENTRY_NOT_FOUND",tiv:"REMOTE_FILE_TRASH_ENTRY_INVALID",parent:"REMOTE_FILE_PARENT_NOT_FOUND",notdir:"REMOTE_FILE_PARENT_NOT_DIRECTORY",target:"REMOTE_FILE_TARGET_EXISTS",rename:"REMOTE_FILE_RENAME_UNSUPPORTED",unconf:"REMOTE_FILE_RESULT_UNCONFIRMED",limit:"REMOTE_FILE_ENTRY_LIMIT"};`;

const ENTRY_COMMON = String.raw`
function rd(f){let s;try{s=fs.lstatSync(f,{bigint:!0})}catch(e){if(e.code==="ENOENT")F(E.missing);throw e}if(kd(s)==="other")F(E.unsup);return s}
function par(r){const q=p.dirname(r);return q==="."?"":q}
`;

const ENTRY_BODY = String.raw`
function op(r){const b=A(r);let s;try{s=fs.lstatSync(b.file,{bigint:!0})}catch(e){if(e.code==="ENOENT")F(E.parent);throw e}if(!s.isDirectory()||s.isSymbolicLink())F(E.notdir);const h=fs.openSync(b.file,O.O_RDONLY|O.O_DIRECTORY|O.O_NOFOLLOW);D.push(h);const a="/proc/self/fd/"+h,q=fs.realpathSync(b.file);if(fs.realpathSync(a)!==q)F(E.parent);return{anchor:a,parent:q}}
let result;
try{
if(action==="stat"){const b=A(relative),s=rd(b.file);C(b);const k=kd(s);result={ok:!0,stat:{kind:k,...(k==="file"?{bytes:Number(s.size)}:{}),mtimeMs:Number(s.mtimeMs)},revision:id(s)}}
else if(action==="create-file"||action==="create-dir"){const b=op(args.parent),t=b.anchor+"/"+args.name;
if(action==="create-file"){const h=fs.openSync(t,O.O_WRONLY|O.O_CREAT|O.O_EXCL|O.O_NOFOLLOW,438);try{const s=fs.fstatSync(h,{bigint:!0});if(!s.isFile()||s.size!==0n||(s.mode&14336n)!==0n)F(E.unconf)}finally{fs.closeSync(h)}}else{fs.mkdirSync(t,{mode:511});const s=fs.lstatSync(t,{bigint:!0});if(!s.isDirectory()||s.isSymbolicLink())F(E.unconf)}
C(b);result={ok:!0,relativePath:args.parent===""?args.name:args.parent+"/"+args.name,kind:action==="create-file"?"file":"directory"}}
else if(action==="rename"){const a=args.source,t=args.target,na=p.basename(a),nb=p.basename(t),b=A(a),s=rd(b.file);
if(JSON.stringify(id(s))!==JSON.stringify(args.revision))F(E.changed);
const q=par(t),c=op(q),f=c.anchor+"/"+nb,co=p.dirname(a)===q&&na!==nb&&na.toLowerCase()===nb.toLowerCase();
let z;try{z=fs.lstatSync(f,{bigint:!0})}catch(e){if(e.code!=="ENOENT")throw e}
if(z!==undefined&&!(co&&sameIdent(z,args.revision)))F(E.target);
if(kd(s)==="file"){if(z===undefined){try{fs.linkSync(b.file,f)}catch(e){if(e.code==="EEXIST")F(E.target);if(["EXDEV","EPERM","ENOSYS","ENOTSUP","EMLINK"].includes(e.code))F(E.rename);if(e.code==="ENOENT")F(E.changed);throw e}const h=fs.lstatSync(f,{bigint:!0}),y=id(h);if(!sameIdent(h,args.revision)||y.size!==args.revision.size||y.mtimeNs!==args.revision.mtimeNs)F(E.unconf);try{fs.unlinkSync(b.file)}catch(e){if(e.code!=="ENOENT")F(E.unconf)}}else{try{fs.renameSync(b.file,f)}catch(e){if(e.code==="EXDEV"||e.code==="EPERM")F(E.rename);throw e}if(!sameIdent(fs.lstatSync(f,{bigint:!0}),args.revision))F(E.unconf)}}
else{try{fs.renameSync(b.file,f)}catch(e){if(e.code==="EEXIST"||e.code==="ENOTEMPTY")F(E.target);if(e.code==="EXDEV"||e.code==="EPERM")F(E.rename);if(e.code==="ENOENT")F(E.changed);throw e}if(!sameIdent(fs.lstatSync(f,{bigint:!0}),args.revision))F(E.unconf)}
try{fs.lstatSync(b.file);F(co?E.rename:E.unconf)}catch(e){if(e.code!=="ENOENT")throw e}
C(b);C(c);result={ok:!0,relativePath:t}}
else F(E.input)
}catch(e){result={ok:!1,code:M(e,action.startsWith("create")?E.parent:E.changed)}}
finally{Q()}
process.stdout.write(marker+JSON.stringify(result))
`;
const TRASH_PUT_COMMON = String.raw`
function J(s,r){return JSON.stringify(id(s))===JSON.stringify(r)}
function rd(f){let s;try{s=fs.lstatSync(f,{bigint:!0})}catch(e){if(e.code==="ENOENT")F(E.missing);throw e}if(kd(s)==="other")F(E.unsup);return s}
`;

const TRASH_PUT_BODY = String.raw`
let result;
try{
if(action!=="delete")F(E.input);
const b=A(args.relative),src=b.anchor+"/"+p.basename(args.relative),s=rd(src),k=kd(s);
if(!J(s,args.revision))F(E.changed);
const rb=A(""),tp=rb.anchor+"/.pideck-trash";
let ts;try{ts=fs.lstatSync(tp,{bigint:!0})}catch(e){if(e.code!=="ENOENT")throw e}
if(ts===undefined){try{fs.mkdirSync(tp,{mode:448})}catch(e){if(e.code!=="EEXIST")F(E.trash)}ts=fs.lstatSync(tp,{bigint:!0})}
if(!ts.isDirectory()||ts.isSymbolicLink())F(E.trash);
const th=fs.openSync(tp,O.O_RDONLY|O.O_DIRECTORY|O.O_NOFOLLOW);D.push(th);
const ta="/proc/self/fd/"+th;if(fs.realpathSync(ta)!==fs.realpathSync(tp))F(E.trash);
const ep=ta+"/"+args.trashId;
let ee=!0;try{fs.lstatSync(ep,{bigint:!0})}catch(e){if(e.code==="ENOENT")ee=!1;else throw e}
if(ee)F(E.busy);
fs.mkdirSync(ep,{mode:448});
const eh=fs.openSync(ep,O.O_RDONLY|O.O_DIRECTORY|O.O_NOFOLLOW);D.push(eh);
const ea="/proc/self/fd/"+eh;if(fs.realpathSync(ea)!==fs.realpathSync(ep))F(E.trash);
const mt=JSON.stringify({schemaVersion:1,id:args.trashId,originalPath:args.relative,name:p.basename(args.relative),kind:k,...(k==="file"?{bytes:Number(s.size)}:{}),deletedAt:args.deletedAt,expiresAt:args.expiresAt,revision:args.revision});
if(Buffer.byteLength(mt,"utf8")>8192)F(E.input);
const mp=ea+"/entry.json",mh=fs.openSync(mp,O.O_WRONLY|O.O_CREAT|O.O_EXCL|O.O_NOFOLLOW,384);
try{fs.writeFileSync(mh,mt);fs.fsyncSync(mh)}finally{fs.closeSync(mh)}
const pp=ea+"/payload";
try{fs.renameSync(src,pp)}catch(e){try{fs.unlinkSync(mp);fs.rmdirSync(ep)}catch{}if(e.code==="EXDEV")F(E.trash);if(e.code==="ENOENT")F(E.changed);if(e.code==="EACCES"||e.code==="EPERM")F("REMOTE_FILE_PERMISSION_DENIED");throw e}
const ps=fs.lstatSync(pp,{bigint:!0});
if(!sameIdent(ps,args.revision)){try{fs.renameSync(pp,src)}catch{F(E.unconf)}try{fs.unlinkSync(mp);fs.rmdirSync(ep)}catch{}F(E.changed)}
let sg=!1;try{fs.lstatSync(src)}catch(e){if(e.code==="ENOENT")sg=!0;else throw e}
if(!sg)F(E.unconf);
const bk=JSON.parse(fs.readFileSync(mp).toString("utf8"));
if(bk.id!==args.trashId||bk.originalPath!==args.relative||bk.kind!==k)F(E.unconf);
C(b);C(rb);result={ok:!0,trashId:args.trashId}
}catch(e){result={ok:!1,code:M(e,E.changed)}}
finally{Q()}
process.stdout.write(marker+JSON.stringify(result))
`;

/**
 * 回收站 list 是纯读：脚本只做回收站/条目 fd 锚定、原始 manifest 有界读回（<=8KiB、JSON 可解析、id 匹配）
 * 与 payload 身份校验；**严格 schema 重验在 main**（readRemoteTrashListOutput）完成，再把合法字段下发渲染层。
 * 这样 list 不必复制 restore/prune 的完整校验器，也不会因为预算而放松严格性。
 */
const TRASH_LIST_COMMON = String.raw`
function ot(){const rb=A(""),t=rb.anchor+"/.pideck-trash";let s;try{s=fs.lstatSync(t,{bigint:!0})}catch(e){if(e.code==="ENOENT")return;throw e}if(!s.isDirectory()||s.isSymbolicLink())F(E.trash);const h=fs.openSync(t,O.O_RDONLY|O.O_DIRECTORY|O.O_NOFOLLOW);D.push(h);const a="/proc/self/fd/"+h;if(fs.realpathSync(a)!==fs.realpathSync(t))F(E.trash);return{anchor:a}}
function oe(t,i){const q=t.anchor+"/"+i;let s;try{s=fs.lstatSync(q,{bigint:!0})}catch(e){if(e.code==="ENOENT")F(E.tnf);throw e}if(!s.isDirectory()||s.isSymbolicLink())F(E.tiv);const h=fs.openSync(q,O.O_RDONLY|O.O_DIRECTORY|O.O_NOFOLLOW);D.push(h);const a="/proc/self/fd/"+h;if(fs.realpathSync(a)!==fs.realpathSync(q))F(E.tiv);return{anchor:a}}
function rq(a,i){let n;try{n=fs.readdirSync(a)}catch{return}if(n.some((q)=>q!=="entry.json"&&q!=="payload"))return;let h;try{h=fs.openSync(a+"/entry.json",O.O_RDONLY|O.O_NOFOLLOW)}catch{return}try{const s=fs.fstatSync(h,{bigint:!0});if(!s.isFile()||s.size>8192n)return;let v;try{v=JSON.parse(fs.readFileSync(h).toString("utf8"))}catch{return}if(!v||typeof v!=="object"||Array.isArray(v)||v.id!==i)return;return v}finally{fs.closeSync(h)}}
function chk(a,i){const v=rq(a,i);if(!v)return{state:"invalid"};let s;try{s=fs.lstatSync(a+"/payload",{bigint:!0})}catch(e){return e.code==="ENOENT"?{state:"payload-missing",m:v}:{state:"invalid"}}if(kd(s)==="other"||kd(s)!==v.kind)return{state:"payload-changed",m:v};try{return{state:sameIdent(s,v.revision)?"intact":"payload-changed",m:v}}catch{return{state:"invalid"}}}
`;

const TRASH_LIST_BODY = String.raw`
let result;
try{
if(action!=="list")F(E.input);
const t=ot();
if(t===undefined)result={ok:!0,entries:[],truncated:!1};
else{const ids=fs.readdirSync(t.anchor).filter((q)=>/^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}$/.test(q)).sort(),tr=ids.length>256,sel=ids.slice(-256),es=[];
for(const i of sel){const q=t.anchor+"/"+i;let s;try{s=fs.lstatSync(q,{bigint:!0})}catch{continue}let e={state:"invalid"};if(s.isDirectory()&&!s.isSymbolicLink()){try{const o=oe(t,i);e=chk(o.anchor,i)}catch{e={state:"invalid"}}}es.push({id:i,state:e.state,...(e.m===undefined?{}:{raw:e.m})})}
es.sort((a,b)=>{const x=a.raw===undefined?"":a.raw.deletedAt,y=b.raw===undefined?"":b.raw.deletedAt;return x<y?1:x>y?-1:0});
let tr2=tr;while(es.length>0&&Buffer.byteLength(JSON.stringify(es),"utf8")>60000){es.pop();tr2=!0}
result={ok:!0,entries:es,truncated:tr2}}
}catch(e){result={ok:!1,code:M(e,E.trash)}}
finally{Q()}
process.stdout.write(marker+JSON.stringify(result))
`;

/** restore/prune 共用：回收站/条目 fd 锚定 + 严格 manifest 重验（字段集合封闭、路径规则、payload 身份）。 */
const TRASH_ADMIN_COMMON = String.raw`
function ot(){const rb=A(""),t=rb.anchor+"/.pideck-trash";let s;try{s=fs.lstatSync(t,{bigint:!0})}catch(e){if(e.code==="ENOENT")return;throw e}if(!s.isDirectory()||s.isSymbolicLink())F(E.trash);const h=fs.openSync(t,O.O_RDONLY|O.O_DIRECTORY|O.O_NOFOLLOW);D.push(h);const a="/proc/self/fd/"+h;if(fs.realpathSync(a)!==fs.realpathSync(t))F(E.trash);return{anchor:a,path:t}}
function oe(t,i){const q=t.anchor+"/"+i;let s;try{s=fs.lstatSync(q,{bigint:!0})}catch(e){if(e.code==="ENOENT")F(E.tnf);throw e}if(!s.isDirectory()||s.isSymbolicLink())F(E.tiv);const h=fs.openSync(q,O.O_RDONLY|O.O_DIRECTORY|O.O_NOFOLLOW);D.push(h);const a="/proc/self/fd/"+h;if(fs.realpathSync(a)!==fs.realpathSync(q))F(E.tiv);return{anchor:a,path:q}}
function par(r){const q=p.dirname(r);return q==="."?"":q}
function rel(v){if(typeof v!=="string"||!v||v.length>4096||v.startsWith("/")||/[\u0000-\u001f\u007f\\]/.test(v))return false;return v.split("/").every((q)=>q&&q!=="."&&q!=="..")}
function rm(a,i){let n;try{n=fs.readdirSync(a)}catch{return}if(n.some((q)=>q!=="entry.json"&&q!=="payload"))return;let h;try{h=fs.openSync(a+"/entry.json",O.O_RDONLY|O.O_NOFOLLOW)}catch{return}try{const s=fs.fstatSync(h,{bigint:!0});if(!s.isFile()||s.size>8192n)return;let v;try{v=JSON.parse(fs.readFileSync(h).toString("utf8"))}catch{return}if(!v||typeof v!=="object"||Array.isArray(v))return;if(Object.keys(v).filter((k)=>k!=="bytes").join()!=="schemaVersion,id,originalPath,name,kind,deletedAt,expiresAt,revision")return;if(v.schemaVersion!==1||v.id!==i||!rel(v.originalPath)||(v.kind!=="file"&&v.kind!=="directory")||v.name!==p.basename(v.originalPath)||typeof v.deletedAt!=="string"||typeof v.expiresAt!=="string"||!v.revision||typeof v.revision!=="object"||Array.isArray(v.revision)||Object.keys(v.revision).join()!=="mode,size,dev,ino,uid,gid,mtimeNs,ctimeNs")return;if(v.kind==="file"?!Number.isSafeInteger(v.bytes)||v.bytes<0:v.bytes!==undefined)return;return v}finally{fs.closeSync(h)}}
function st(a,i){const v=rm(a,i);if(!v)return{state:"invalid"};let s;try{s=fs.lstatSync(a+"/payload",{bigint:!0})}catch(e){return e.code==="ENOENT"?{state:"payload-missing",m:v}:{state:"invalid"}}if(kd(s)==="other"||kd(s)!==v.kind)return{state:"payload-changed",m:v};return{state:sameIdent(s,v.revision)?"intact":"payload-changed",m:v}}
`;

const TRASH_RESTORE_BODY = String.raw`
let result;
try{
if(action!=="restore")F(E.input);
if(!/^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}$/.test(args.id))F(E.input);
const t=ot();if(t===undefined)F(E.tnf);
const e=oe(t,args.id),x=st(e.anchor,args.id);if(x.state!=="intact")F(E.tiv);
const v=x.m,q=par(v.originalPath),pp=root+"/"+q;
let s;try{s=fs.lstatSync(pp,{bigint:!0})}catch(err){if(err.code==="ENOENT")F(E.parent);throw err}
if(!s.isDirectory()||s.isSymbolicLink())F(E.notdir);
const tb=A(q),tf=tb.anchor+"/"+p.basename(v.originalPath);
try{fs.lstatSync(tf);F(E.target)}catch(err){if(err.code!=="ENOENT")throw err}
const pl=e.anchor+"/payload";
if(v.kind==="directory"){try{fs.renameSync(pl,tf)}catch(err){if(err.code==="EEXIST"||err.code==="ENOTEMPTY")F(E.target);if(err.code==="EXDEV"||err.code==="EPERM")F(E.rename);if(err.code==="ENOENT")F(E.tiv);throw err}}
else{try{fs.linkSync(pl,tf)}catch(err){if(err.code==="EEXIST")F(E.target);if(err.code==="EXDEV"||err.code==="EPERM"||err.code==="ENOSYS")F(E.rename);if(err.code==="ENOENT")F(E.tiv);throw err}}
const r=fs.lstatSync(tf,{bigint:!0}),c=id(r);if(c.dev!==v.revision.dev||c.ino!==v.revision.ino||c.mode!==v.revision.mode)F(E.unconf);
if(v.kind==="file"){try{fs.unlinkSync(pl)}catch(err){if(err.code!=="ENOENT")F(E.unconf)}}
let pg=!1;try{fs.lstatSync(pl)}catch(err){if(err.code==="ENOENT")pg=!0;else throw err}
if(!pg)F(E.unconf);
try{fs.unlinkSync(e.anchor+"/entry.json")}catch{}
try{fs.rmdirSync(e.path)}catch{}
C(tb);R();result={ok:!0,relativePath:v.originalPath}
}catch(err){result={ok:!1,code:M(err,E.tiv)}}
finally{Q()}
process.stdout.write(marker+JSON.stringify(result))
`;

const TRASH_PRUNE_BODY = String.raw`
function wb(t){const st=[[t,0]];let n=0;while(st.length>0){const q=st.pop();let s;try{s=fs.lstatSync(q[0],{bigint:!0})}catch{return 20001}n+=1;if(n>20000||q[1]>32)return 20001;if(s.isDirectory()&&!s.isSymbolicLink())for(const x of fs.readdirSync(q[0]))st.push([q[0]+"/"+x,q[1]+1])}return n}
let result;
try{
if(action!=="prune")F(E.input);
if(!Array.isArray(args.ids)||args.ids.length===0)F(E.input);
const removed=[],kept=[],t=ot();
for(const i of args.ids){try{
if(t===undefined){kept.push({id:i,code:E.tnf});continue}
const e=oe(t,i),x=st(e.anchor,i);if(x.state==="invalid"){kept.push({id:i,code:E.tiv});continue}
const pl=e.anchor+"/payload";
if(x.state!=="payload-missing"){let s;try{s=fs.lstatSync(pl,{bigint:!0})}catch(err){if(err.code!=="ENOENT")throw err}if(s!==undefined){if(s.isDirectory()&&!s.isSymbolicLink()){if(wb(pl)>20000){kept.push({id:i,code:E.limit});continue}}else if(kd(s)==="other"){kept.push({id:i,code:E.tiv});continue}if(s.isDirectory()&&!s.isSymbolicLink())fs.rmSync(pl,{recursive:!0,force:!1,maxRetries:0});else fs.unlinkSync(pl)}}
try{fs.unlinkSync(e.anchor+"/entry.json")}catch(err){if(err.code!=="ENOENT")throw err}
fs.rmdirSync(e.path);removed.push(i)
}catch(err){const m=err&&err.message||"";kept.push({id:i,code:/^REMOTE_[A-Z_]+$/.test(m)?m:err&&(err.code==="EACCES"||err.code==="EPERM")?"REMOTE_FILE_PERMISSION_DENIED":"REMOTE_FILE_COMMAND_FAILED"})}}
R();result={ok:!0,removed:removed,kept:kept}
}catch(err){result={ok:!1,code:M(err,"REMOTE_FILE_COMMAND_FAILED")}}
finally{Q()}
process.stdout.write(marker+JSON.stringify(result))
`;

export const REMOTE_PROJECT_ENTRY_SCRIPT = BOUNDARY_SCRIPT + BASE + E_ENTRY + ENTRY_COMMON + ENTRY_BODY;
export const REMOTE_PROJECT_TRASH_PUT_SCRIPT = BOUNDARY_SCRIPT + BASE + E_PUT + TRASH_PUT_COMMON + TRASH_PUT_BODY;
export const REMOTE_PROJECT_TRASH_LIST_SCRIPT = BOUNDARY_SCRIPT + BASE + E_LIST + TRASH_LIST_COMMON + TRASH_LIST_BODY;
export const REMOTE_PROJECT_TRASH_RESTORE_SCRIPT = BOUNDARY_SCRIPT + BASE + E_ADMIN + TRASH_ADMIN_COMMON + TRASH_RESTORE_BODY;
export const REMOTE_PROJECT_TRASH_PRUNE_SCRIPT = BOUNDARY_SCRIPT + BASE + E_ADMIN + TRASH_ADMIN_COMMON + TRASH_PRUNE_BODY;

const TRASH_SCRIPTS: Record<"list" | "restore" | "prune", string> = {
	list: REMOTE_PROJECT_TRASH_LIST_SCRIPT,
	restore: REMOTE_PROJECT_TRASH_RESTORE_SCRIPT,
	prune: REMOTE_PROJECT_TRASH_PRUNE_SCRIPT,
};

type BuildInput = { nodePath: string; root: string; nonce: string };

function assertBuildPaths(input: BuildInput): void {
	try {
		if (readCanonicalBrowseRoot(input.root).canonicalPath !== input.root || readCanonicalBrowseRoot(input.nodePath).canonicalPath !== input.nodePath) throw new Error();
	} catch {
		throw new Error("REMOTE_FILE_PATH_INVALID");
	}
	if (!input.nodePath.endsWith("/node") || !/^[a-f0-9]{32}$/.test(input.nonce)) throw new Error("REMOTE_FILE_INPUT_INVALID");
}

function buildCommand(input: BuildInput & { script: string; operation: string; relative: string; args: unknown; markerPrefix: string }): { command: string; marker: string } {
	assertBuildPaths(input);
	const marker = input.markerPrefix + input.nonce;
	const script = input.script.replace(/\s+/g, " ").trim();
	const command = [input.nodePath, "-e", script, input.operation, marker, input.root, input.relative, JSON.stringify(input.args)].map(quotePosixArgument).join(" ");
	if (command.length > REMOTE_HELPER_MAX_REMOTE_COMMAND_LENGTH) throw new Error("REMOTE_FILE_INPUT_INVALID");
	return { command: command, marker: marker };
}

export type RemoteProjectEntryCommand = { operation: "stat"; relative: string } | { operation: "create-file"; parent: string; name: string } | { operation: "create-dir"; parent: string; name: string } | { operation: "rename"; source: string; target: string; revision: RemoteEntryRevision };

/** entry/trash 命令共用同一套构造纪律：单引号字面量 argv、marker 带 32 hex nonce、8192 字符预算。 */
export function buildRemoteProjectEntryCommand(input: BuildInput & { command: RemoteProjectEntryCommand }): { command: string; marker: string } {
	const command = input.command;
	if (command.operation === "stat") {
		validateRemoteProjectEntryPath(command.relative);
		assertRemoteProjectEntryMutablePath(command.relative);
		return buildCommand({ ...input, script: REMOTE_PROJECT_ENTRY_SCRIPT, operation: command.operation, relative: command.relative, args: {}, markerPrefix: "PIDECK_ENTRY_" });
	}
	if (command.operation === "create-file" || command.operation === "create-dir") {
		validateRemoteProjectParentPath(command.parent);
		validateRemoteProjectEntryName(command.name);
		assertRemoteProjectEntryCreatable(command.parent, command.name);
		return buildCommand({ ...input, script: REMOTE_PROJECT_ENTRY_SCRIPT, operation: command.operation, relative: command.parent, args: { parent: command.parent, name: command.name }, markerPrefix: "PIDECK_ENTRY_" });
	}
	validateRemoteProjectEntryPath(command.source);
	validateRemoteProjectEntryPath(command.target);
	assertRemoteProjectEntryMutablePath(command.source);
	assertRemoteProjectEntryMutablePath(command.target);
	const revision = readRemoteEntryRevision(command.revision);
	return buildCommand({ ...input, script: REMOTE_PROJECT_ENTRY_SCRIPT, operation: command.operation, relative: command.source, args: { source: command.source, target: command.target, revision: revision }, markerPrefix: "PIDECK_ENTRY_" });
}

export type RemoteProjectTrashCommand = { operation: "list" } | { operation: "delete"; relative: string; revision: RemoteEntryRevision; trashId: string; deletedAt: string; expiresAt: string } | { operation: "restore"; trashId: string } | { operation: "prune"; trashIds: string[] };

function isIsoTimestamp(value: unknown): value is string {
	return typeof value === "string" && value.length <= 64 && !Number.isNaN(Date.parse(value));
}

/**
 * 回收站命令：delete 走 TRASH_PUT_SCRIPT（先写 manifest 再 rename 源条目）；
 * list/restore/prune 各自成脚本以压住 5120 squash 预算，共用回收站/条目 fd 锚定与严格 manifest 重验。
 */
export function buildRemoteProjectTrashCommand(input: BuildInput & { command: RemoteProjectTrashCommand }): { command: string; marker: string } {
	const command = input.command;
	if (command.operation === "delete") {
		validateRemoteProjectEntryPath(command.relative);
		assertRemoteProjectEntryMutablePath(command.relative);
		const revision = readRemoteEntryRevision(command.revision);
		validateRemoteProjectTrashId(command.trashId);
		if (!isIsoTimestamp(command.deletedAt) || !isIsoTimestamp(command.expiresAt)) throw new Error("REMOTE_FILE_INPUT_INVALID");
		return buildCommand({ ...input, script: REMOTE_PROJECT_TRASH_PUT_SCRIPT, operation: command.operation, relative: command.relative, args: { relative: command.relative, revision: revision, trashId: command.trashId, deletedAt: command.deletedAt, expiresAt: command.expiresAt }, markerPrefix: "PIDECK_TRASH_" });
	}
	if (command.operation === "restore") {
		validateRemoteProjectTrashId(command.trashId);
		return buildCommand({ ...input, script: TRASH_SCRIPTS.restore, operation: command.operation, relative: "", args: { id: command.trashId }, markerPrefix: "PIDECK_TRASH_" });
	}
	if (command.operation === "prune") {
		if (!Array.isArray(command.trashIds) || command.trashIds.length === 0 || command.trashIds.length > REMOTE_PROJECT_TRASH_MAX_IDS) throw new Error("REMOTE_FILE_INPUT_INVALID");
		const unique = new Set(command.trashIds.map(validateRemoteProjectTrashId));
		if (unique.size !== command.trashIds.length) throw new Error("REMOTE_FILE_INPUT_INVALID");
		return buildCommand({ ...input, script: TRASH_SCRIPTS.prune, operation: command.operation, relative: "", args: { ids: [...unique] }, markerPrefix: "PIDECK_TRASH_" });
	}
	return buildCommand({ ...input, script: TRASH_SCRIPTS.list, operation: command.operation, relative: "", args: {}, markerPrefix: "PIDECK_TRASH_" });
}
