"use strict";(()=>{function x(t,i){return(t+1)%i}function M(t){return Math.min(40,Math.max(1,Math.floor((t-15+6)/13)))}var A=["p1","p2","p3","p4"];function L(){let t=document.createElement("div");return t.className="wake-art",t.setAttribute("aria-hidden","true"),t.innerHTML=`
    <div class="wake-art-view is-active" data-art="a">
      <div class="wake-ports">
        <div class="wake-port p1"><span class="wake-port-label">P1</span><i></i><b></b></div>
        <div class="wake-port p2"><span class="wake-port-label">P2</span><i></i><b></b></div>
        <div class="wake-port p3"><span class="wake-port-label">P3</span><i></i><b></b></div>
        <div class="wake-port p4"><span class="wake-port-label">P4</span><i></i><b></b></div>
      </div>
    </div>
    <div class="wake-art-view" data-art="c">
      <div class="wake-dots">
        ${A.map(i=>`<div class="wake-dot-row ${i}"></div>`).join("")}
      </div>
    </div>
    <div class="wake-art-view wake-rollback" data-art="b">
      <svg class="rb" viewBox="-2 0 70 30" aria-hidden="true" focusable="false">
        <rect x="0" y="17" width="64" height="1" class="axis" />
        <rect class="t" x="2" y="8" width="2" height="8" />
        <rect class="t" x="8" y="8" width="2" height="8" />
        <rect class="t" x="14" y="8" width="2" height="8" />
        <rect class="t" x="20" y="8" width="2" height="8" />
        <rect class="t t4" x="26" y="8" width="2" height="8" />
        <rect class="t t5" x="32" y="8" width="2" height="8" />
        <rect class="t t6" x="38" y="8" width="2" height="8" />
        <rect class="t" x="44" y="8" width="2" height="8" />
        <rect class="t" x="50" y="8" width="2" height="8" />
        <rect class="t" x="56" y="8" width="2" height="8" />
        <rect class="t" x="62" y="8" width="2" height="8" />
        <rect class="head" x="1" y="5" width="4" height="14" rx="1" />
        <text class="lbl bad" x="39" y="26" text-anchor="middle">wrong guess</text>
        <text class="lbl re" x="27" y="26" text-anchor="middle">rewind \xB7 replay</text>
      </svg>
    </div>`,t}function y(){let t=document.querySelector("#st-waking, #inv-waking"),i=t?.querySelector(".prog");if(!t||!i)return;let n=t,a=L();i.after(a);let m=a.querySelector(".wake-dots");if(!m)return;let c=m;function p(){let e=M(c.clientWidth);c.querySelectorAll(".wake-dot-row").forEach(r=>{r.replaceChildren(...Array.from({length:e},(f,T)=>{let k=document.createElement("i");return k.style.setProperty("--dot-index",String(T)),k}))})}p(),new ResizeObserver(p).observe(c);let l=[...a.querySelectorAll(".wake-art-view")],d=[...a.querySelectorAll(".wake-port")],b=window.matchMedia("(prefers-reduced-motion: reduce)"),w=Number(window.__KN_WAKE_ART_CYCLE_MS__??8e3),o=null,s=[],h=0;function u(e){h=e,l.forEach((r,f)=>{r.classList.toggle("is-active",f===e)})}w===0&&(window.__KN_WAKE_ART_STEP__=()=>u(x(h,l.length)));function E(){o!==null&&window.clearTimeout(o),o=null,s.forEach(e=>{window.clearTimeout(e)}),s=[],d.forEach(e=>{e.classList.remove("is-lit")}),u(0)}function g(){s=[],d.forEach((e,r)=>{s.push(window.setTimeout(()=>e.classList.add("is-lit"),r*500))}),s.push(window.setTimeout(()=>{d.forEach(e=>{e.classList.remove("is-lit")})},2600)),s.push(window.setTimeout(g,3200))}function _(){w!==0&&(o=window.setTimeout(()=>{u(x(h,l.length)),_()},w))}function v(){E(),a.classList.toggle("is-waking",!n.hidden),!n.hidden&&!b.matches&&(g(),_())}new MutationObserver(v).observe(n,{attributes:!0,attributeFilter:["hidden"]}),b.addEventListener?.("change",v),v()}y();})();
