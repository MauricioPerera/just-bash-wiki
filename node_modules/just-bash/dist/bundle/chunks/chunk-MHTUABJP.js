async function c(e,t){if(e.length>0&&e[0]!=="-"){let i=t.fs.resolvePath(t.cwd,e[0]);try{let s=(await t.fs.readFile(i)).split(`
`);s[s.length-1]===""&&s.pop();let r=s.reverse();return{stdout:r.length>0?`${r.join(`
`)}
`:"",stderr:"",exitCode:0}}catch{return{stdout:"",stderr:`tac: ${e[0]}: No such file or directory
`,exitCode:1}}}let n=t.stdin.split(`
`);n[n.length-1]===""&&n.pop();let o=n.reverse();return{stdout:o.length>0?`${o.join(`
`)}
`:"",stderr:"",exitCode:0}}var l={name:"tac",execute:c},a={name:"tac",flags:[],stdinType:"text",needsFiles:!0};export{l as a,a as b};
