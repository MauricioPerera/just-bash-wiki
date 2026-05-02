import{a as y}from"./chunk-3THT3N7L.js";import{a as C}from"./chunk-HWKDQ44K.js";import{a as u,b as m}from"./chunk-74CEPOFO.js";var x={name:"tr",summary:"translate or delete characters",usage:"tr [OPTION]... SET1 [SET2]",options:["-c, -C, --complement   use the complement of SET1","-d, --delete           delete characters in SET1","-s, --squeeze-repeats  squeeze repeated characters","    --help             display this help and exit"],description:`SET syntax:
  a-z         character range
  [:alnum:]   all letters and digits
  [:alpha:]   all letters
  [:digit:]   all digits
  [:lower:]   all lowercase letters
  [:upper:]   all uppercase letters
  [:space:]   all whitespace
  [:blank:]   horizontal whitespace
  [:punct:]   all punctuation
  [:print:]   all printable characters
  [:graph:]   all printable characters except space
  [:cntrl:]   all control characters
  [:xdigit:]  all hexadecimal digits
  \\n, \\t, \\r  escape sequences`},b=new Map([["[:alnum:]","ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"],["[:alpha:]","ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"],["[:blank:]"," 	"],["[:cntrl:]",Array.from({length:32},(r,o)=>String.fromCharCode(o)).join("").concat("\x7F")],["[:digit:]","0123456789"],["[:graph:]",Array.from({length:94},(r,o)=>String.fromCharCode(33+o)).join("")],["[:lower:]","abcdefghijklmnopqrstuvwxyz"],["[:print:]",Array.from({length:95},(r,o)=>String.fromCharCode(32+o)).join("")],["[:punct:]","!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~"],["[:space:]",` 	
\r\f\v`],["[:upper:]","ABCDEFGHIJKLMNOPQRSTUVWXYZ"],["[:xdigit:]","0123456789ABCDEFabcdef"]]);function S(r){let o="",e=0;for(;e<r.length;){if(r[e]==="["&&r[e+1]===":"){let a=!1;for(let[c,l]of b)if(r.slice(e).startsWith(c)){o+=l,e+=c.length,a=!0;break}if(a)continue}if(r[e]==="\\"&&e+1<r.length){let a=r[e+1];a==="n"?o+=`
`:a==="t"?o+="	":a==="r"?o+="\r":o+=a,e+=2;continue}if(e+2<r.length&&r[e+1]==="-"){let a=r.charCodeAt(e),c=r.charCodeAt(e+2);if(c-a>65536)throw new Error(`tr: character range too large: '${r[e]}-${r[e+2]}'`);for(let l=a;l<=c;l++)o+=String.fromCharCode(l);e+=3;continue}o+=r[e],e++}return o}var w={complement:{short:"c",long:"complement",type:"boolean"},complementUpper:{short:"C",type:"boolean"},delete:{short:"d",long:"delete",type:"boolean"},squeeze:{short:"s",long:"squeeze-repeats",type:"boolean"}},q={name:"tr",async execute(r,o){if(m(r))return u(x);let e=C("tr",r,w);if(!e.ok)return e.error;let a=e.result.flags.complement||e.result.flags.complementUpper,c=e.result.flags.delete,l=e.result.flags.squeeze,p=e.result.positional;if(p.length<1)return{stdout:"",stderr:`tr: missing operand
`,exitCode:1};if(!c&&!l&&p.length<2)return{stdout:"",stderr:`tr: missing operand after SET1
`,exitCode:1};let d,s;try{d=S(p[0]),s=p.length>1?S(p[1]):""}catch(n){return{stdout:"",stderr:`${y(n.message)}
`,exitCode:1}}let g=o.stdin,h=n=>{let t=d.includes(n);return a?!t:t},i="";if(c)for(let n of g)h(n)||(i+=n);else if(l&&p.length===1){let n="";for(let t of g)h(t)&&t===n||(i+=t,n=t)}else{if(a){let n=s.length>0?s[s.length-1]:"";for(let t of g)d.includes(t)?i+=t:i+=n}else{let n=new Map;for(let t=0;t<d.length;t++){let f=t<s.length?s[t]:s[s.length-1];n.set(d[t],f)}for(let t of g)i+=n.get(t)??t}if(l){let n="",t="";for(let f of i)s.includes(f)&&f===t||(n+=f,t=f);i=n}}return{stdout:i,stderr:"",exitCode:0}}},T={name:"tr",flags:[{flag:"-c",type:"boolean"},{flag:"-C",type:"boolean"},{flag:"-d",type:"boolean"},{flag:"-s",type:"boolean"}],stdinType:"text",needsArgs:!0};export{q as a,T as b};
