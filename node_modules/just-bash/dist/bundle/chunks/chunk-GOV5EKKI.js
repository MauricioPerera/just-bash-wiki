import{a as d}from"./chunk-3ZUFRYJ4.js";import{a as n,b as i}from"./chunk-A5O5YHGN.js";import{a,b as l}from"./chunk-74CEPOFO.js";var u={name:"sleep",summary:"delay for a specified amount of time",usage:"sleep NUMBER[SUFFIX]",description:`Pause for NUMBER seconds. SUFFIX may be:
  s - seconds (default)
  m - minutes
  h - hours
  d - days

NUMBER may be a decimal number.`,options:["    --help display this help and exit"]},m=36e5,h={name:"sleep",async execute(r,s){if(l(r))return a(u);if(r.length===0)return{stdout:"",stderr:`sleep: missing operand
`,exitCode:1};let t=0;for(let e of r){let o=d(e);if(o===null)return{stdout:"",stderr:`sleep: invalid time interval '${e}'
`,exitCode:1};t+=o}return t>m&&(t=m),s.signal?.aborted?{stdout:"",stderr:"",exitCode:0}:(s.sleep?await s.sleep(t):s.signal?await new Promise(e=>{let o=()=>{i(p),e()},p=n(()=>{s.signal?.removeEventListener("abort",o),e()},t);s.signal?.addEventListener("abort",o,{once:!0})}):await new Promise(e=>n(e,t)),{stdout:"",stderr:"",exitCode:0})}},b={name:"sleep",flags:[],needsArgs:!0};export{h as a,b};
