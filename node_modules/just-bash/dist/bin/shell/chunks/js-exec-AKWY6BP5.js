#!/usr/bin/env node
import{a as A,b as P}from"./chunk-XXCTETRW.js";import"./chunk-4OALHZXB.js";import"./chunk-HC7WB764.js";import"./chunk-NTW6IA45.js";import"./chunk-LIYVQA3X.js";import{a as k,b as T}from"./chunk-OOJCYVYF.js";import{a as W}from"./chunk-4PRVMER6.js";import{b as C}from"./chunk-YU6OGPZR.js";import{a as M,b as y}from"./chunk-RLNOQILG.js";import{a as v}from"./chunk-4VDEBYW7.js";import{b as F}from"./chunk-GTNBSMZR.js";import"./chunk-KGOUQS5A.js";import{AsyncLocalStorage as U}from"node:async_hooks";import{randomBytes as I}from"node:crypto";import{fileURLToPath as J}from"node:url";import{Worker as D}from"node:worker_threads";var N=1e4,H=6e4,B=new U,_=`js-exec - Sandboxed JavaScript/TypeScript runtime with Node.js-compatible APIs

Usage: js-exec [OPTIONS] [-c CODE | FILE] [ARGS...]

Options:
  -c CODE          Execute inline code
  -m, --module     Enable ES module mode (import/export)
  --strip-types    Strip TypeScript type annotations
  --version, -V    Show version
  --help           Show this help

Examples:
  js-exec -c "console.log(1 + 2)"
  js-exec script.js
  js-exec app.ts
  echo 'console.log("hello")' | js-exec

File Extension Auto-Detection:
  .js              script mode (module mode if top-level await detected)
  .mjs             ES module mode
  .ts, .mts        ES module mode + TypeScript stripping

Node.js Compatibility:
  Code written for Node.js largely works here. Both require and import
  are supported, the node: prefix works, and standard globals like process,
  console, and fetch are available. All I/O is synchronous.

  Available modules:
    fs, path, child_process, process, console,
    os, url, assert, util, events, buffer, stream,
    string_decoder, querystring

  fs (global, require('fs'), or import from 'node:fs'):
    readFileSync, writeFileSync, appendFileSync, copyFileSync, renameSync
    readdirSync, mkdirSync, rmSync, unlinkSync, rmdirSync
    statSync, lstatSync, existsSync, realpathSync, chmodSync
    symlinkSync, readlinkSync, readFileBuffer
    fs.promises.readFile, fs.promises.writeFile, fs.promises.access, ...

  path: join, resolve, dirname, basename, extname, normalize,
    relative, isAbsolute, parse, format, sep, delimiter

  child_process:
    execSync(cmd)       throws on non-zero exit, returns stdout
    spawnSync(cmd, args) returns { stdout, stderr, status }

  process (also global): argv, cwd(), exit(), env, platform, arch,
    version, versions

  os: platform(), arch(), homedir(), tmpdir(), type(), hostname(),
    EOL, cpus(), endianness()

  url: URL, URLSearchParams, parse(), format()

  assert: ok(), equal(), strictEqual(), deepEqual(), throws(),
    doesNotThrow(), fail()

  util: format(), inspect(), promisify(), types, inherits()

  events: EventEmitter (on, once, emit, off, removeListener, ...)

  buffer: Buffer.from(), Buffer.alloc(), Buffer.concat(),
    Buffer.isBuffer(), toString(), slice(), equals()

  stream: Readable, Writable, Duplex, Transform, PassThrough, pipeline

  string_decoder: StringDecoder (write, end)

  querystring: parse(), stringify(), escape(), unescape()

Other Globals:
  console            log (stdout), error/warn (stderr)
  fetch(url, opts)   HTTP; returns Promise<Response> (Web Fetch API)
  URL, URLSearchParams, Headers, Request, Response
  Buffer             Buffer.from(), Buffer.alloc(), etc.

Not Available:
  http, https, net, tls, crypto, zlib, dns, cluster, worker_threads,
  vm, v8, readline, and other Node.js built-in modules that require
  native bindings. Use fetch() for HTTP requests.

Limits:
  Memory: 64 MB per execution
  Timeout: 10 s (60 s with network; configurable via maxJsTimeoutMs)
  Engine: QuickJS (compiled to WebAssembly)
`;function z(t){let e={code:null,scriptFile:null,showVersion:!1,scriptArgs:[],isModule:!1,stripTypes:!1};if(t.length===0)return e;for(let r=0;r<t.length;r++){let s=t[r];if(s==="-m"||s==="--module"){e.isModule=!0;continue}if(s==="--strip-types"){e.stripTypes=!0;continue}if(s==="-c")return r+1>=t.length?{stdout:"",stderr:`js-exec: option requires an argument -- 'c'
`,exitCode:2}:(e.code=t[r+1],e.scriptArgs=t.slice(r+2),e);if(s==="--version"||s==="-V")return e.showVersion=!0,e;if(s.startsWith("-")&&s!=="-"&&s!=="--")return{stdout:"",stderr:`js-exec: unrecognized option '${s}'
`,exitCode:2};if(s==="--")return r+1<t.length&&(e.scriptFile=t[r+1],e.scriptArgs=t.slice(r+2)),e;if(!s.startsWith("-"))return e.scriptFile=s,e.scriptArgs=t.slice(r+1),e}return e}var i=null,w=null,c=[],o=null,$=J(new URL("./js-exec-worker.js",import.meta.url));function p(){for(;c.length>0&&c[0].canceled;)c.shift();if(o||c.length===0)return;let t=c.shift();if(!t)return;o=t,Q().postMessage(o.input)}function V(t,e){if(!t||typeof t!="object")return{success:!1,error:"Malformed worker response"};let r=t;return typeof r.protocolToken!="string"||r.protocolToken!==e?{success:!1,error:"Malformed worker response: invalid protocol token"}:typeof r.success!="boolean"?{success:!1,error:"Malformed worker response: missing success flag"}:r.success?{success:!0}:{success:!1,error:typeof r.error=="string"&&r.error.length>0?r.error:"Worker execution failed"}}function Q(){if(w&&(T(w),w=null),i)return i;let t=C.runTrusted(()=>new D($));return i=t,t.on("message",e=>{if(i===t){if(o){let r=V(e,o.input.protocolToken);o.resolve(r),o=null}c.length>0?p():G()}}),t.on("error",e=>{if(i===t){if(o){let r=y(v(e));o.resolve({success:!1,error:r}),o=null}for(let r of c)r.resolve({success:!1,error:"Worker crashed"});c.length=0,i=null}}),t.on("exit",()=>{i===t&&(i=null,o&&(o.resolve({success:!1,error:"Worker exited unexpectedly"}),o=null),c.length>0&&p())}),t}function G(){w=k(()=>{i&&!o&&c.length===0&&(i.terminate(),i=null)},5e3)}async function K(t,e,r,s=[],n,u,a){return B.getStore()?{stdout:"",stderr:`js-exec: recursive invocation is not supported
`,exitCode:1}:X(t,e,r,s,n,u,a)}async function X(t,e,r,s=[],n,u,a){let m=A(),d=e.exec,g=d?(l,b)=>B.run(!0,()=>d(l,b)):void 0,q=new P(m,e.fs,e.cwd,"js-exec",e.fetch,e.limits?.maxOutputSize??0,g),E=e.limits?.maxJsTimeoutMs??N,h=e.fetch?Math.max(E,H):E,O={protocolToken:I(16).toString("hex"),sharedBuffer:m,jsCode:t,cwd:e.cwd,env:W(e.env),args:s,scriptPath:r,bootstrapCode:n,isModule:u,stripTypes:a,timeoutMs:h},j,L=new Promise(l=>{j=l}),f={input:O,resolve:()=>{}},R=k(()=>{if(o===f){let l=i;l&&(i=null,l.terminate()),o=null,p()}else f.canceled=!0,o||p();f.resolve({success:!1,error:`Execution timeout: exceeded ${h}ms limit`})},h);f.resolve=l=>{T(R),j(l)},c.push(f),p();let[x,S]=await Promise.all([q.run(h),L.catch(l=>({success:!1,error:y(v(l))}))]);return!S.success&&S.error?{stdout:x.stdout,stderr:`${x.stderr}js-exec: ${y(S.error)}
`,exitCode:x.exitCode||1}:x}var de={name:"js-exec",async execute(t,e){if(F(t))return{stdout:_,stderr:"",exitCode:0};let r=z(t);if("exitCode"in r)return r;if(r.showVersion)return{stdout:`QuickJS (quickjs-emscripten)
`,stderr:"",exitCode:0};let s,n;if(r.code!==null)s=r.code,n="-c";else if(r.scriptFile!==null){let d=e.fs.resolvePath(e.cwd,r.scriptFile);if(!await e.fs.exists(d))return{stdout:"",stderr:`js-exec: can't open file '${r.scriptFile}': No such file or directory
`,exitCode:2};try{s=await e.fs.readFile(d),n=d}catch(g){return{stdout:"",stderr:`js-exec: can't open file '${r.scriptFile}': ${M(g.message)}
`,exitCode:2}}}else if(e.stdin.trim())s=e.stdin,n="<stdin>";else return{stdout:"",stderr:`js-exec: no input provided (use -c CODE or provide a script file)
`,exitCode:2};let u=r.isModule,a=r.stripTypes;n&&n!=="-c"&&n!=="<stdin>"&&((n.endsWith(".mjs")||n.endsWith(".mts")||n.endsWith(".ts"))&&(u=!0),(n.endsWith(".ts")||n.endsWith(".mts"))&&(a=!0)),!u&&/\bawait\s+[\w([`]/.test(s)&&(u=!0);let m=e.jsBootstrapCode;return K(s,e,n,r.scriptArgs,m,u,a)}},fe={name:"node",async execute(){return{stdout:"",stderr:`node: this sandbox uses js-exec instead of node

${_}`,exitCode:1}}};export{de as jsExecCommand,fe as nodeStubCommand};
