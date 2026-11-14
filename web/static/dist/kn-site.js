"use strict";(()=>{var G="/api/version",J="[version-guard]",q=e=>typeof e!="object"||e===null?"":typeof e.version=="string"?e.version:"",W=e=>{if(e?.running===!0)return!0;let n=e?.sessionStats;return!n||!("frames"in n)?!1:typeof n.frames=="number"&&n.frames>0},U=(e,n)=>e||!n,X=(e,n,a,r,o)=>n===""||n===e?"nothing":n!==a?r?"reload":"waiting-for-idle":r&&!o?"reload-on-idle":"nothing",Y=(e,n,a)=>`VERSION-MISMATCH page=${e} server=${n} action=${a}`,M=e=>{let n=e.document.querySelector('meta[name="kn-asset-version"]')?.getAttribute("content")||"";if(!n)return;let a=!1,r="",o=(f,m)=>{let u=Y(n,f,m);e.console.warn(`${J} ${u}`);try{e.KNLockstep?.logSync?e.KNLockstep.logSync(u):e.KNState?._syncLog&&e.KNState._syncLog(u)}catch{}try{typeof e.KNEvent=="function"&&e.KNEvent("version_mismatch",u,{page_version:n,server_version:f,action:m})}catch{}},g=()=>{if(e.document.hidden)return!0;let f=!1;try{f=W(e.KNState)}catch{}return U(!1,f)},k=()=>{a||(a=!0,e.setTimeout(()=>{let f=()=>{let m=e.location.href;e.location.href=m};try{typeof e.location.reload=="function"?e.location.reload():f()}catch{f()}},200))},L=async()=>{try{let f=await e.fetch(G,{cache:"no-store",credentials:"same-origin"});if(!f.ok)return;let m=q(await f.json());if(m===""||m===n)return;let u=X(n,m,r,g(),a);if(u==="nothing")return;u!=="reload-on-idle"&&(r=m),o(m,u),u!=="waiting-for-idle"&&k()}catch{}};L(),e.setInterval(()=>{L()},6e4),e.addEventListener("visibilitychange",()=>{e.document.hidden||L()}),e.addEventListener("focus",()=>{L()})};var O=new Map([["bug",{emoji:"\u{1F41B}",label:"Bug Report",placeholder:"What happened? Steps to reproduce if possible..."}],["feature",{emoji:"\u{1F4A1}",label:"Feature",placeholder:"What would you like to see?"}],["general",{emoji:"\u{1F4AC}",label:"General",placeholder:"What's on your mind?"}]]),Z=e=>e==="bug"||e==="feature"||e==="general"?e:null,R=e=>O.get(e??"general")?.placeholder??"",Q=(e,n)=>e.includes("play.html")?"game":new URLSearchParams(n).get("room")?"lobby":"home",ee=e=>e.includes("/play"),ne=e=>{let n={url:e.href,page:Q(e.pathname,e.search),userAgent:e.userAgent,timestamp:e.now};e.playerName&&(n.playerName=e.playerName);let a=e.state;if(a){if(a.room&&(n.roomCode=a.room),a.matchId&&(n.matchId=a.matchId),a.slot!=null&&(n.playerSlot=a.slot),a.peers){let o=Object.values(a.peers);n.peerCount=o.length;let g=new Map;for(let k of o)k.pc&&g.set(k.sid||"unknown",k.pc.connectionState||"unknown");g.size&&(n.peerStates=Object.fromEntries(g))}a.sessionStats&&(n.sessionStats={...a.sessionStats})}let r=new URLSearchParams(e.search).get("mode");return r&&(n.mode=r),n},te=(e,n)=>({category:e.category||"general",message:e.message.trim(),email:e.email.trim()||null,company_fax:e.trap,page:n.page,context:n}),N=(e,n)=>n?"Thanks for your feedback!":e===429?"Please wait before submitting again":"Submission failed, please try again",oe=(e,n,a)=>e||n&&a,ae=`
      .kn-feedback-fab {
        position: fixed; bottom: 20px; right: 20px; z-index: 150;
        width: 48px; height: 48px; border-radius: 50%;
        background: #e94560; color: #fff; border: none; cursor: pointer;
        font-size: 20px; display: flex; align-items: center; justify-content: center;
        box-shadow: 0 4px 16px rgba(233,69,96,0.4);
        transition: transform 0.15s, box-shadow 0.15s;
      }
      .kn-feedback-fab.kn-feedback-play-fab {
        bottom: calc(20px + env(safe-area-inset-bottom, 0px));
        z-index: 120;
      }
      @media (max-width: 600px) {
        .kn-feedback-fab.kn-feedback-play-fab {
          right: calc(16px + env(safe-area-inset-right, 0px));
          bottom: calc(16px + env(safe-area-inset-bottom, 0px));
        }
      }
      .kn-feedback-fab:hover {
        transform: scale(1.1);
        box-shadow: 0 6px 20px rgba(233,69,96,0.5);
      }
      .kn-feedback-fab[hidden] { display: none; }
      .kn-feedback-fab-tooltip {
        position: absolute; bottom: 56px; right: 0;
        background: #0f0f23; border: 1px solid #333; border-radius: 8px;
        padding: 6px 10px; color: #aaa; font-size: 11px; white-space: nowrap;
        pointer-events: none; opacity: 0; transition: opacity 0.15s;
      }
      .kn-feedback-fab:hover .kn-feedback-fab-tooltip { opacity: 1; }

      @keyframes kn-feedback-pulse {
        0%, 100% { box-shadow: 0 4px 16px rgba(233,69,96,0.4); }
        50% { box-shadow: 0 0 24px rgba(233,69,96,0.8); }
      }
      .kn-feedback-fab.intro { animation: kn-feedback-pulse 1.5s ease-in-out 3; }
      .kn-feedback-callout {
        position: absolute; bottom: 56px; right: 0;
        background: #0f0f23; border: 1px solid #e94560; border-radius: 8px;
        padding: 8px 12px; color: #eee; font-size: 12px; white-space: nowrap;
        pointer-events: none; opacity: 0; transition: opacity 0.3s;
      }
      .kn-feedback-callout.show { opacity: 1; }

      .kn-feedback-backdrop {
        position: fixed; inset: 0; z-index: 301;
        background: rgba(0,0,0,0.6); display: flex;
        align-items: center; justify-content: center;
        opacity: 0; transition: opacity 0.15s;
      }
      .kn-feedback-backdrop.open { opacity: 1; }
      .kn-feedback-backdrop[hidden] { display: none; }

      .kn-feedback-modal {
        background: #0f0f23; border: 1px solid #333; border-radius: 12px;
        width: 90%; max-width: 440px; padding: 24px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.5);
        max-height: 90vh; overflow-y: auto;
      }
      .kn-feedback-header {
        display: flex; justify-content: space-between; align-items: center;
        margin-bottom: 20px;
      }
      .kn-feedback-header h3 { color: #fff; font-size: 18px; margin: 0; }
      .kn-feedback-close {
        background: none; border: none; color: #666; font-size: 20px;
        cursor: pointer; padding: 4px 8px;
      }
      .kn-feedback-close:hover { color: #fff; }

      .kn-feedback-categories {
        display: flex; gap: 8px; margin-bottom: 16px;
      }
      .kn-feedback-cat {
        flex: 1; padding: 10px; text-align: center; border-radius: 8px;
        font-size: 13px; font-weight: 500; cursor: pointer;
        background: #16213e; color: #aaa; border: 1px solid #333;
        transition: background 0.1s, color 0.1s;
      }
      .kn-feedback-cat:hover { border-color: #e94560; }
      .kn-feedback-cat.active {
        background: #e94560; color: #fff; border-color: #e94560;
      }

      .kn-feedback-label {
        display: block; color: #888; font-size: 12px; margin-bottom: 4px;
        text-transform: uppercase; letter-spacing: 0.5px;
      }
      .kn-feedback-textarea {
        width: 100%; min-height: 100px; padding: 12px;
        background: #16213e; border: 1px solid #333; border-radius: 8px;
        color: #eee; font-size: 14px; resize: vertical;
        font-family: inherit; margin-bottom: 16px; box-sizing: border-box;
      }
      .kn-feedback-textarea:focus { outline: none; border-color: #e94560; }

      .kn-feedback-email {
        width: 100%; padding: 10px 12px;
        background: #16213e; border: 1px solid #333; border-radius: 8px;
        color: #eee; font-size: 14px; margin-bottom: 16px;
        font-family: inherit; box-sizing: border-box;
      }
      .kn-feedback-email:focus { outline: none; border-color: #e94560; }

      .kn-feedback-context-hint {
        background: #16213e; border-radius: 6px; padding: 8px 12px;
        margin-bottom: 16px; display: flex; align-items: center; gap: 8px;
      }
      .kn-feedback-context-dot {
        width: 8px; height: 8px; border-radius: 50%; background: #4ecca3;
        flex-shrink: 0;
      }
      .kn-feedback-context-text { color: #888; font-size: 12px; }

      .kn-feedback-submit {
        width: 100%; padding: 12px; border-radius: 8px; border: none;
        background: #e94560; color: #fff; font-weight: 600; font-size: 14px;
        cursor: pointer; transition: opacity 0.15s;
      }
      .kn-feedback-submit:disabled {
        opacity: 0.4; cursor: not-allowed;
      }
      .kn-feedback-submit:not(:disabled):hover { opacity: 0.9; }

      .kn-feedback-hp {
        position: absolute; left: -9999px; width: 1px; height: 1px;
        overflow: hidden; opacity: 0;
      }

      .kn-feedback-toolbar-item {
        width: 100%; text-align: left; padding: 10px 16px;
        background: none; border: none; color: #ccc;
        cursor: pointer; font-size: 14px;
      }
      .kn-feedback-toolbar-item:hover { background: #1a1a3e; }

      .kn-feedback-session-prompt {
        position: fixed;
        bottom: calc(80px + env(safe-area-inset-bottom, 0px));
        left: 50%;
        transform: translateX(-50%);
        background: #0f0f23;
        border: 1px solid #333;
        border-radius: 8px;
        padding: 10px 20px;
        color: #eee;
        font-size: 14px;
        z-index: 151;
        box-shadow: 0 4px 12px rgba(0,0,0,0.4);
        cursor: pointer;
        max-width: calc(100vw - 24px);
        text-align: center;
        white-space: nowrap;
      }
      .kn-feedback-session-prompt a {
        color: #e94560;
        text-decoration: underline;
        margin-left: 4px;
      }
      .kn-feedback-session-prompt-lobby {
        top: calc(12px + env(safe-area-inset-top, 0px));
        bottom: auto;
      }
      @media (max-width: 600px) {
        .kn-feedback-session-prompt {
          padding: 8px 12px;
          font-size: 13px;
          white-space: normal;
        }
      }
    `,re=()=>`
      <div class="kn-feedback-modal" role="dialog" aria-label="Send Feedback">
        <div class="kn-feedback-header">
          <h3>Send Feedback</h3>
          <button class="kn-feedback-close" aria-label="Close">&times;</button>
        </div>
        <div class="kn-feedback-categories">${[...O].map(([n,{emoji:a,label:r}])=>`<button type="button" class="kn-feedback-cat" data-cat="${n}">${a} ${r}</button>`).join("")}</div>
        <label class="kn-feedback-label" for="kn-fb-message">Message</label>
        <textarea class="kn-feedback-textarea" id="kn-fb-message"
          placeholder="${R(null)}"></textarea>
        <input class="kn-feedback-email" id="kn-fb-email" type="email"
          placeholder="Email (optional, for follow-up)" />
        <input class="kn-feedback-hp" name="company_fax" tabindex="-1"
          autocomplete="off" aria-hidden="true" />
        <div class="kn-feedback-context-hint">
          <span class="kn-feedback-context-dot"></span>
          <span class="kn-feedback-context-text">Session context will be attached automatically</span>
        </div>
        <button class="kn-feedback-submit" disabled>Send Feedback</button>
      </div>
    `,A=(e,n,a)=>{let r=Array.from(e).find(n);if(r===void 0)throw new Error(`feedback form has no ${a}`);return r},K=e=>{let{document:n}=e,a=ee(e.location.pathname),r=null,o=null,g=null,k=null,L=()=>{let t=null;try{t=e.localStorage.getItem("kaillera-name")}catch{}return ne({href:e.location.href,pathname:e.location.pathname,search:e.location.search,userAgent:e.navigator.userAgent,now:e.Date.now(),playerName:t,state:e.KNState})},f=t=>{if(typeof e.showToast=="function"){e.showToast(t);return}let i=n.createElement("div");i.textContent=t,Object.assign(i.style,{position:"fixed",bottom:"80px",left:"50%",transform:"translateX(-50%)",background:"#0f0f23",border:"1px solid #333",borderRadius:"8px",padding:"10px 20px",color:"#eee",fontSize:"14px",zIndex:"100001",boxShadow:"0 4px 12px rgba(0,0,0,0.4)"}),n.body.appendChild(i),e.setTimeout(()=>i.remove(),3e3)},m=t=>{t.send.disabled=!t.message.value.trim()},u=()=>{if(!o)return;let{backdrop:t,message:i}=o;t.hidden=!1,e.requestAnimationFrame(()=>t.classList.add("open")),i.focus()},I=()=>{if(!o)return;let{backdrop:t}=o;t.classList.remove("open"),e.setTimeout(()=>{t.hidden=!0},150)},s=async t=>{if(!t.message.value.trim())return;t.send.disabled=!0,t.send.textContent="Sending...";let i=te({category:r,message:t.message.value,email:t.email.value,trap:t.trap.value},L());try{let p=await e.fetch("/api/feedback",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(i)});if(p.ok){I(),f(N(p.status,!0)),r=null,t.message.value="",t.email.value="",t.trap.value="";for(let b of t.categories)b.classList.remove("active");t.message.placeholder=R(null),m(t)}else f(N(p.status,!1))}catch{f(N(null,!1))}finally{t.send.disabled=!1,t.send.textContent="Send Feedback",m(t)}},d=()=>{let t=n.createElement("style");t.textContent=ae,n.head.appendChild(t)},l=()=>{let t=n.createElement("button");t.className=a?"kn-feedback-fab kn-feedback-play-fab":"kn-feedback-fab",t.setAttribute("aria-label","Send feedback"),t.innerHTML='\u{1F4AC}<span class="kn-feedback-fab-tooltip">Send Feedback</span>',t.addEventListener("click",u),n.body.appendChild(t),g=t},c=()=>{let t=n.createElement("div");t.className="kn-feedback-backdrop",t.hidden=!0,t.addEventListener("click",y=>{y.target===t&&I()}),t.innerHTML=re();let i=t.getElementsByTagName("button"),p=t.getElementsByTagName("input"),b={backdrop:t,message:A(t.getElementsByTagName("textarea"),()=>!0,"message box"),email:A(p,y=>y.name!=="company_fax","email field"),trap:A(p,y=>y.name==="company_fax","trap field"),send:A(i,y=>y.classList.contains("kn-feedback-submit"),"send button"),categories:Array.from(i).filter(y=>y.classList.contains("kn-feedback-cat"))};A(i,y=>y.classList.contains("kn-feedback-close"),"close button").addEventListener("click",I);for(let y of b.categories)y.addEventListener("click",()=>{r=Z(y.dataset.cat);for(let j of b.categories)j.classList.toggle("active",j===y);b.message.placeholder=R(r),m(b)});b.message.addEventListener("input",()=>m(b)),b.send.addEventListener("click",()=>{s(b)}),n.body.appendChild(t),o=b},w=()=>{if(!a)return;let t=n.getElementById("more-dropdown");if(!t)return;let i=n.createElement("button");i.className="more-option kn-feedback-toolbar-item",i.setAttribute("role","menuitem"),i.textContent="Feedback",i.style.display="none",i.addEventListener("click",()=>{typeof e.KNCloseMoreDropdown=="function"?e.KNCloseMoreDropdown():t.classList.add("hidden"),u()});let p=n.getElementById("toolbar-end");p?t.insertBefore(i,p):t.appendChild(i),k=i},x=t=>{let i=n.getElementById(t);return!!i&&!i.classList.contains("hidden")},h=()=>{if(!a||!g)return;let t=x("toolbar"),i=x("overlay"),p=e.matchMedia("(max-width: 600px)").matches;g.hidden=oe(t,i,p),k&&(k.style.display=t?"":"none")},E=(t,i)=>{let p=n.getElementById(t);if(!p)return null;let b=new e.MutationObserver(i);return b.observe(p,{attributes:!0,attributeFilter:["class"]}),b},S=t=>{t.classList.toggle("kn-feedback-session-prompt-lobby",a&&x("overlay"))},C=()=>{if(!g&&!k)return;let t=n.createElement("div");t.className="kn-feedback-session-prompt",t.innerHTML='How was your session? <a href="#">Share feedback</a>',S(t),A(t.getElementsByTagName("a"),()=>!0,"prompt link").addEventListener("click",p=>{p.preventDefault(),t.remove(),u()}),n.body.appendChild(t);let i=a?E("overlay",()=>S(t)):null;e.setTimeout(()=>{i&&i.disconnect(),t.parentNode&&t.remove()},8e3)},v=t=>{let i=n.createElement("span");i.className="kn-feedback-callout",i.textContent="Got feedback? Let us know!",t.appendChild(i),t.classList.add("intro"),e.requestAnimationFrame(()=>i.classList.add("show"));let p=()=>{i.classList.remove("show"),t.classList.remove("intro");try{e.localStorage.setItem("kn-feedback-seen","1")}catch{}e.setTimeout(()=>i.remove(),300)};e.setTimeout(p,6e3),t.addEventListener("click",p,{once:!0})},F=()=>{d(),l(),c(),w(),a&&(h(),E("toolbar",h),E("overlay",h),e.setInterval(h,1e3)),n.addEventListener("keydown",t=>{t.key==="Escape"&&o&&!o.backdrop.hidden&&I()});try{e.localStorage.getItem("kn-feedback-prompt")&&(e.localStorage.removeItem("kn-feedback-prompt"),e.setTimeout(()=>C(),1e3))}catch{}try{!a&&!e.localStorage.getItem("kn-feedback-seen")&&g&&v(g)}catch{}};return n.readyState==="loading"?n.addEventListener("DOMContentLoaded",F):F(),{prompt:C,open:u}};var B=e=>typeof e!="object"||e===null||Array.isArray(e)?null:e,ie=e=>{let n=B(e)?.version;return typeof n=="string"?n:null},se=e=>{let n=B(e);return typeof n?.type=="string"&&typeof n.message=="string"?{type:n.type,message:n.message}:null},de=e=>{let n=B(e);if(typeof n?.version!="string"||typeof n.date!="string"||!Array.isArray(n.changes))return null;let a=[];for(let r of n.changes){let o=se(r);if(o===null)return null;a.push(o)}return{version:n.version,date:n.date,changes:a}},le=e=>{if(!Array.isArray(e))return null;let n=[];for(let a of e){let r=de(a);if(r===null)return null;n.push(r)}return n},ce=new Map([["&","&amp;"],["<","&lt;"],[">","&gt;"],['"',"&quot;"],["'","&#39;"]]),T=e=>e.replaceAll(/[&<>"']/g,n=>ce.get(n)??n),pe=new Map([["0.21.0","Agent's Version"]]),ge=e=>{let n=e===null?void 0:pe.get(e);return n?`v${e} \u2014 ${n}`:null},fe=e=>`<strong style="color:#fff">v${T(e.version)}</strong> <span style="color:#666;margin-left:8px">${T(e.date)}</span>`,me=e=>(e.type==="feat"?'<span style="color:#4ade80">+</span> ':'<span style="color:#f59e0b">\u2022</span> ')+T(e.message),ue=[["Kaillera (2001)","Christophe Thibault"],["EmuLinker","Moosehead"],["EmuLinker SF","Suprafast"],["SupraClient","Suprafast"],["n02 p2p","Jugoso, Killer Civilian"],["Project64k","Hotquik"],["AQZ NetPlay","CoderTimZ, CEnnis91"],["Ownasaurus Client","Ownasaurus"],["EmuLinker X","Near, Firo, Ownasaurus, Agent 21"],["EmuLinker-K","hopskipnfall"],["Kaillera Reborn","God-Weapon & community"],["kaillera-next","Agent 21"]],ye=(e,n)=>`<strong style="color:#fff">${T(e)}</strong> <span style="color:#888">\u2014 ${T(n)}</span>`,be=[["GitHub","https://github.com/kwilson21/kaillera-next"],["Support (Ko-fi)","https://ko-fi.com/kazonwilson"]],ke=["It started at my grandparents' house. I was bored with nothing to do when my grandfather asked if I wanted to play Sonic. There was no Sega in sight \u2014 he pointed me to the PC. A data CD on the desk had a Sega emulator and some ROMs. I figured out how to set it up and played Sonic on an emulator for the first time.","A year or two later, I got curious at home and found the same emulator online. That led me to Project64, where I discovered I could play Super Smash Bros. 64 \u2014 a game I'd only played once as a kid and always wanted to play again.","Then I found the netplay tab. That's how I discovered Kaillera \u2014 and started playing SSB64 online with people from all over. I made a lot of friends through that community.","I always wanted to fix the problems with the emulator, the server, and the clients. But I was only 9 to 12 years old. Learning C++ and Java felt impossible. I got involved with the community efforts to improve things as best I could, eventually moved on, but never forgot about it.","Now, with the help of AI, I'm finally building what I always wanted Kaillera to be."],P="\u25B6",V="\u25BC",z=e=>{let{document:n}=e,a=null,r=null,o=(s,d,l)=>{let c=n.createElement(s);return l!==void 0&&(c.textContent=l),Object.assign(c.style,d),c},g=(s,d)=>{n.getElementById(s)?.remove();let l=o("div",{position:"fixed",inset:"0",background:"rgba(0,0,0,0.7)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:"99999",padding:"20px"});l.id=s;let c=o("div",{background:"#1a1a2e",border:"1px solid #333",borderRadius:"12px",maxWidth:"520px",width:"100%",maxHeight:"80vh",overflow:"auto",padding:"24px",color:"#ccc",fontFamily:"system-ui, sans-serif",fontSize:"14px"}),w=o("div",{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"16px"}),x=o("button",{background:"none",border:"none",color:"#888",fontSize:"24px",cursor:"pointer",padding:"0 4px"},"\xD7");return x.addEventListener("click",()=>l.remove()),w.append(d,x),c.appendChild(w),{backdrop:l,card:c}},k=(s,d)=>{s.appendChild(d),n.body.appendChild(s),s.addEventListener("click",c=>{c.target===s&&s.remove()});let l=c=>{c.key==="Escape"&&(s.remove(),n.removeEventListener("keydown",l))};n.addEventListener("keydown",l)},L=(s,d,l)=>{s.addEventListener("click",()=>{let c=d.style.display!=="none";d.style.display=c?"none":"block",l.textContent=c?P:V})},f=s=>{let{backdrop:d,card:l}=g("kn-changelog-modal",o("h2",{margin:"0",color:"#fff",fontSize:"18px"},"Changelog"));s.forEach((c,w)=>{let x=o("div",{marginBottom:"12px"}),h=o("div",{cursor:"pointer",padding:"8px 0",borderBottom:"1px solid #333",display:"flex",justifyContent:"space-between",alignItems:"center"}),E=o("span",{});E.innerHTML=fe(c);let S=o("span",{color:"#666"},w===0?V:P);h.append(E,S);let C=o("ul",{margin:"8px 0 0 0",padding:"0 0 0 20px",display:w===0?"block":"none"});for(let v of c.changes){let F=o("li",{marginBottom:"4px"});F.innerHTML=me(v),C.appendChild(F)}L(h,C,S),x.append(h,C),l.appendChild(x)}),k(d,l)},m=async()=>{if(!a){try{let s=await e.fetch(`/static/changelog.json?_t=${Date.now()}`);a=le(await s.json())}catch{return}if(!a)return}f(a)},u=()=>{let{backdrop:s,card:d}=g("kn-about-modal",o("h2",{margin:"0",color:"#c9a227",fontSize:"20px"},"kaillera-next")),l=ge(r);l!==null&&d.appendChild(o("div",{color:"#c9a227",fontSize:"13px",marginBottom:"16px",fontStyle:"italic"},l));let c=o("div",{marginBottom:"16px"});for(let[S,C]of ue){let v=o("div",{marginBottom:"4px"});v.innerHTML=ye(S,C),c.appendChild(v)}c.appendChild(o("div",{color:"#666",fontStyle:"italic",marginTop:"8px"},"...and the countless others who kept Kaillera alive")),d.appendChild(c);let w=o("div",{marginBottom:"16px",display:"flex",gap:"16px"});for(let[S,C]of be){let v=o("a",{},S);v.setAttribute("href",C),v.setAttribute("target","_blank"),v.setAttribute("rel","noopener"),Object.assign(v.style,{color:"#c9a227",textDecoration:"none",fontSize:"13px"}),w.appendChild(v)}d.appendChild(w);let x=o("div",{cursor:"pointer",padding:"8px 0",borderTop:"1px solid #333",display:"flex",justifyContent:"space-between",alignItems:"center"}),h=o("span",{color:"#666"},P);x.append(o("span",{color:"#fff"},"The Story"),h);let E=o("div",{display:"none"});for(let S of ke)E.appendChild(o("p",{margin:"0 0 10px 0",lineHeight:"1.5",color:"#aaa"},S));L(x,E,h),d.append(x,E),k(s,d)},I=async()=>{for(let s of n.querySelectorAll("#kn-about"))s.addEventListener("click",u);try{let s=await e.fetch(`/static/version.json?_t=${Date.now()}`),d=ie(await s.json());if(d===null)return;r=d;for(let l of n.querySelectorAll("#kn-version"))l.textContent=`v${d}`,l.addEventListener("click",()=>{m()})}catch{}};n.readyState==="loading"?n.addEventListener("DOMContentLoaded",()=>{I()}):I()};var xe={startFeedback:K,startVersion:z,startVersionGuard:M},H=()=>{window.KNSite=xe};var _="__kn__",D=(e,n)=>{try{return e[n].setItem(_,"1"),e[n].removeItem(_),!0}catch{return!1}},ve=e=>{let n=new Map,a={localStorage:D(e,"localStorage"),sessionStorage:D(e,"sessionStorage")};return{get:(r,o)=>a[r]?e[r].getItem(o):n.get(`${r}:${o}`)??null,set:(r,o,g)=>{a[r]?e[r].setItem(o,g):n.set(`${r}:${o}`,g)},remove:(r,o)=>{a[r]?e[r].removeItem(o):n.delete(`${r}:${o}`)}}},$=()=>{window.KNStorage=ve(window)};$();H();})();
