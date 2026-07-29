import"./supabase-client-ByXZZmbi.js";import"./auth-helper-CowPKJcP.js";import{g as e,i as t,l as n,t as r}from"./db-nXN2EJa5.js";import"./auth-guard-CxreNMEC.js";var i=document.getElementById(`menu-toggle`),a=document.getElementById(`navbar`);i.addEventListener(`click`,()=>a.classList.toggle(`mobile-active`));var o=document.getElementById(`generate-plan-btn`),s=document.getElementById(`exam-name`),c=document.getElementById(`exam-days`),l=document.getElementById(`daily-hours`),u=document.getElementById(`timeline-container`),d=null,f=JSON.parse(localStorage.getItem(`planner-checks`)||`{}`);function p(){localStorage.setItem(`planner-checks`,JSON.stringify(f))}function m(e,t){let n=e.split(/(?:,|\.|;)\s+/).map(e=>e.trim()).filter(e=>e.length>6);return n.length>=2?n:[e]}function h(e,t,n){let r=[{title:`Core Fundamentals Review`,tasks:[`Review key definitions and core concepts`,`Read foundational chapters and annotate`,`Create a summary sheet of formulas`,`Use AI Tutor to clarify confusing topics`]},{title:`Practice Problems & Active Recall`,tasks:[`Solve ${n*8} practice problems on core topics`,`Use flashcards for active recall on key terms`,`Review mistakes and note weak areas`,`Complete a short AI-generated quiz`]},{title:`Deep Dive — Advanced Concepts`,tasks:[`Study advanced or edge-case topics`,`Cross-reference notes with textbook`,`Revisit flashcard decks at medium difficulty`,`Ask AI Tutor about complex sub-topics`]},{title:`Formula Sheet & Key Term Synthesis`,tasks:[`Compile all formulas into one reference sheet`,`Write definitions from memory (closed-book)`,`Re-study any forgotten terms`,`Generate a custom flashcard deck`]},{title:`Mock Exam & Weak Spot Analysis`,tasks:[`Take a full timed practice quiz`,`Analyse incorrect answers carefully`,`Re-read relevant sections for weak areas`,`Update summary notes with corrections`]},{title:`Speed Drills & Timed Practice`,tasks:[`Complete 2 sets of timed problem sets`,`Focus on accuracy under pressure`,`Review timed results and log patterns`,`Do a speed-run flashcard session`]},{title:`Final Comprehensive Review`,tasks:[`Read through your full summary sheet`,`Do a final full-length practice quiz`,`Review any remaining flagged topics`,`Rest well — preparation is complete ✓`]}];return Array.from({length:t},(t,n)=>{let i=r[n%r.length];return{day:n+1,title:`${e} — ${i.title}`,tasks:i.tasks}})}function g(e,t){let n=t||s.value.trim()||`plan`;u.innerHTML=e.map((e,t)=>{let r=e.tasks||m(e.description||``,2),i=r.length,a=r.filter((e,r)=>f[`${n}-${t}-${r}`]).length,o=i?Math.round(a/i*100):0,s=a===i&&i>0,c=r.map((e,r)=>`
            <div class="task-item ${f[`${n}-${t}-${r}`]?`checked`:``}" data-day="${t}" data-task="${r}" data-key="${n}">
              <span class="task-bullet"></span>
              <div class="task-check">
                <svg viewBox="0 0 12 12"><polyline points="2,6 5,9 10,3"/></svg>
              </div>
              <span class="task-text">${e}</span>
            </div>`).join(``);return`
          <div class="timeline-item ${s?`day-complete`:``}" id="day-card-${t}">
            <div class="day-header">
              <div class="day-header-left">
                <span class="day-badge">
                  <span class="day-badge-label">DAY</span>
                  <span class="day-badge-num">${String(e.day).padStart(2,`0`)}</span>
                </span>
                <h3 style="font-size:0.95rem; margin:0;">${e.title}</h3>
              </div>
              <div class="complete-badge ${s?`visible`:``}" id="badge-${t}">
                <svg viewBox="0 0 24 24"><polyline points="20,6 9,17 4,12"/></svg>
                Complete
              </div>
            </div>

            <div class="day-progress-wrap">
              <div class="day-progress-fill" id="prog-${t}" style="width:${o}%"></div>
            </div>
            <div class="day-progress-label ${s?`all-done`:``}" id="prog-lbl-${t}">
              ${s?`✓ All tasks done`:`${a} / ${i} tasks completed`}
            </div>

            <div class="task-list">${c}</div>
          </div>`}).join(``),u.querySelectorAll(`.task-item`).forEach(e=>{e.addEventListener(`click`,()=>{let t=+e.dataset.day,n=+e.dataset.task,r=`${e.dataset.key}-${t}-${n}`;f[r]=!f[r],p(),e.classList.toggle(`checked`,f[r]);let i=document.getElementById(`day-card-${t}`),a=i.querySelectorAll(`.task-item`),o=a.length,s=[...a].filter(e=>e.classList.contains(`checked`)).length,c=o?Math.round(s/o*100):0,l=s===o;document.getElementById(`prog-${t}`).style.width=c+`%`;let u=document.getElementById(`prog-lbl-${t}`);u.textContent=l?`✓ All tasks done`:`${s} / ${o} tasks completed`,u.className=`day-progress-label ${l?`all-done`:``}`,document.getElementById(`badge-${t}`).classList.toggle(`visible`,l),i.classList.toggle(`day-complete`,l)})})}o.addEventListener(`click`,async()=>{let t=s.value.trim()||`Exam`,n=parseInt(c.value),i=parseInt(l.value);o.disabled=!0,o.querySelector(`span`).style.textTransform=`uppercase`,o.querySelector(`span`).textContent=`Generating...`;try{let{plan_items:a}=await r(`plan`,{subject:t,days:n,hours_day:i});g(a,t),d&&await e(d,{subject:t,days:n,hoursDay:i,planItems:a})}catch(r){console.error(`[Planner] AI error:`,r);let a=h(t,n,i);g(a,t),d&&await e(d,{subject:t,days:n,hoursDay:i,planItems:a})}o.disabled=!1,o.querySelector(`span`).textContent=`Create Schedule`}),(async()=>{let e=await t();if(e){d=e.user.id;let t=await n(d);t?.plan_items?.length>0&&(s.value=t.subject||``,c.value=String(t.days||7),l.value=String(t.hours_day||2),g(t.plan_items,t.subject))}})();