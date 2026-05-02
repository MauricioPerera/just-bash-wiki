#!/usr/bin/env node
import{a as f,b as a,c}from"./chunk-GTNBSMZR.js";var u={name:"rev",summary:"reverse lines characterwise",usage:"rev [file ...]",description:"Copies the specified files to standard output, reversing the order of characters in every line. If no files are specified, standard input is read.",examples:["echo 'hello' | rev     # Output: olleh","rev file.txt           # Reverse each line in file"]};function d(t){return Array.from(t).reverse().join("")}var v={name:"rev",execute:async(t,s)=>{if(a(t))return f(u);let o=[];for(let e of t)if(e==="--"){let r=t.indexOf(e);o.push(...t.slice(r+1));break}else{if(e.startsWith("-")&&e!=="-")return c("rev",e);o.push(e)}let n="",l=e=>{let r=e.split(`
`),i=e.endsWith(`
`)&&r[r.length-1]==="";return i&&r.pop(),r.map(d).join(`
`)+(i?`
`:"")};if(o.length===0){let e=s.stdin??"";n=l(e)}else for(let e of o)if(e==="-"){let r=s.stdin??"";n+=l(r)}else{let r=s.fs.resolvePath(s.cwd,e),i=await s.fs.readFile(r);if(i===null)return{exitCode:1,stdout:n,stderr:`rev: ${e}: No such file or directory
`};n+=l(i)}return{exitCode:0,stdout:n,stderr:""}}},m={name:"rev",flags:[],stdinType:"text",needsFiles:!0};export{v as a,m as b};
