#!/usr/bin/env node
import{a as g,b as y,c as $}from"./chunk-GTNBSMZR.js";var x={name:"comm",summary:"compare two sorted files line by line",usage:"comm [OPTION]... FILE1 FILE2",options:["-1             suppress column 1 (lines unique to FILE1)","-2             suppress column 2 (lines unique to FILE2)","-3             suppress column 3 (lines that appear in both files)","    --help     display this help and exit"]},C={name:"comm",async execute(p,a){if(y(p))return g(x);let r=!1,l=!1,f=!1,i=[];for(let e of p)if(e==="-1")r=!0;else if(e==="-2")l=!0;else if(e==="-3")f=!0;else if(e==="-12"||e==="-21")r=!0,l=!0;else if(e==="-13"||e==="-31")r=!0,f=!0;else if(e==="-23"||e==="-32")l=!0,f=!0;else if(e==="-123"||e==="-132"||e==="-213"||e==="-231"||e==="-312"||e==="-321")r=!0,l=!0,f=!0;else{if(e.startsWith("-")&&e!=="-")return $("comm",e);i.push(e)}if(i.length!==2)return{stdout:"",stderr:`comm: missing operand
Try 'comm --help' for more information.
`,exitCode:1};let c=async e=>{if(e==="-")return a.stdin;try{let w=a.fs.resolvePath(a.cwd,e);return await a.fs.readFile(w)}catch{return null}},m=await c(i[0]);if(m===null)return{stdout:"",stderr:`comm: ${i[0]}: No such file or directory
`,exitCode:1};let h=await c(i[1]);if(h===null)return{stdout:"",stderr:`comm: ${i[1]}: No such file or directory
`,exitCode:1};let t=m.split(`
`),s=h.split(`
`);t.length>0&&t[t.length-1]===""&&t.pop(),s.length>0&&s[s.length-1]===""&&s.pop();let n=0,o=0,u="",d=r?"":"	",F=(r?"":"	")+(l?"":"	");for(;n<t.length||o<s.length;)n>=t.length?(l||(u+=`${d}${s[o]}
`),o++):o>=s.length?(r||(u+=`${t[n]}
`),n++):t[n]<s[o]?(r||(u+=`${t[n]}
`),n++):t[n]>s[o]?(l||(u+=`${d}${s[o]}
`),o++):(f||(u+=`${F}${t[n]}
`),n++,o++);return{stdout:u,stderr:"",exitCode:0}}},I={name:"comm",flags:[{flag:"-1",type:"boolean"},{flag:"-2",type:"boolean"},{flag:"-3",type:"boolean"}],needsArgs:!0,minArgs:2};export{C as a,I as b};
