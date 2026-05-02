import{a as i}from"./chunk-X2AJGDEF.js";import{a as u}from"./chunk-HWKDQ44K.js";import{a as g,b as m}from"./chunk-74CEPOFO.js";var S={name:"stat",summary:"display file or file system status",usage:"stat [OPTION]... FILE...",options:["-c FORMAT   use the specified FORMAT instead of the default","    --help  display this help and exit"]},$={format:{short:"c",type:"string"}},A={name:"stat",async execute(n,a){if(m(n))return g(S);let o=u("stat",n,$);if(!o.ok)return o.error;let c=o.result.flags.format??null,f=o.result.positional;if(f.length===0)return{stdout:"",stderr:`stat: missing operand
`,exitCode:1};let r="",p="",d=!1;for(let s of f){let h=a.fs.resolvePath(a.cwd,s);try{let e=await a.fs.stat(h);if(c){let t=c,l=e.mode.toString(8),y=i(e.mode,e.isDirectory);t=t.replace(/%n/g,s),t=t.replace(/%N/g,`'${s}'`),t=t.replace(/%s/g,String(e.size)),t=t.replace(/%F/g,e.isDirectory?"directory":"regular file"),t=t.replace(/%a/g,l),t=t.replace(/%A/g,y),t=t.replace(/%u/g,"1000"),t=t.replace(/%U/g,"user"),t=t.replace(/%g/g,"1000"),t=t.replace(/%G/g,"group"),r+=`${t}
`}else{let t=e.mode.toString(8).padStart(4,"0"),l=i(e.mode,e.isDirectory);r+=`  File: ${s}
`,r+=`  Size: ${e.size}		Blocks: ${Math.ceil(e.size/512)}
`,r+=`Access: (${t}/${l})
`,r+=`Modify: ${e.mtime.toISOString()}
`}}catch{p+=`stat: cannot stat '${s}': No such file or directory
`,d=!0}}return{stdout:r,stderr:p,exitCode:d?1:0}}},M={name:"stat",flags:[{flag:"-c",type:"value",valueHint:"format"},{flag:"-L",type:"boolean"}],needsArgs:!0};export{A as a,M as b};
