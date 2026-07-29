import{t as e}from"./supabase-client-ByXZZmbi.js";import"./auth-helper-CowPKJcP.js";import{a as t,d as n,s as r}from"./db-nXN2EJa5.js";function i(e){let t=Date.now()-new Date(e).getTime(),n=Math.floor(t/6e4);if(n<1)return`Just now`;if(n<60)return`${n}m ago`;let r=Math.floor(n/60);if(r<24)return`${r}h ago`;let i=Math.floor(r/24);return i<7?`${i}d ago`:new Date(e).toLocaleDateString([],{month:`short`,day:`numeric`})}function a(e){return String(e||``).replace(/&/g,`&amp;`).replace(/</g,`&lt;`).replace(/>/g,`&gt;`)}async function o(e){let o=e.user,s=o.user_metadata||{},c=s.full_name||s.name||o.email?.split(`@`)[0]||`there`,l=document.getElementById(`app-header`);l&&(l.style.display=`flex`),document.getElementById(`landing-view`).style.display=`none`,document.getElementById(`dashboard-view`).style.display=`block`,document.getElementById(`greeting-name`).textContent=`Hello, ${c} 👩‍🎓`;let u=o.id,[d,f,p]=await Promise.all([r(u),t(u),n(u)]);document.getElementById(`stat-chats`).textContent=d.chatCount,document.getElementById(`stat-notes`).textContent=d.noteCount,document.getElementById(`stat-quizzes`).textContent=d.quizCount,document.getElementById(`stat-score`).textContent=d.avgScore==null?`—`:`${d.avgScore}%`;let m=document.getElementById(`recent-chats-list`);f.length>0&&(m.innerHTML=f.slice(0,5).map(e=>`
          <a class="recent-chat-item" href="tutor.html">
            <div class="chat-item-icon">AI</div>
            <div class="chat-item-text">
              <div class="chat-item-title">${a(e.title||`New Chat`)}</div>
              <div class="chat-item-meta">${a(e.subject||`General`)} · ${i(e.updated_at)}</div>
            </div>
          </a>`).join(``));let h=document.getElementById(`recent-notes-list`);p.length>0&&(h.innerHTML=p.slice(0,5).map(e=>`
          <a class="recent-chat-item" href="notes.html">
            <div class="chat-item-icon" style="font-size:0.75rem;">📝</div>
            <div class="chat-item-text">
              <div class="chat-item-title">${a(e.title||`Untitled Note`)}</div>
              <div class="chat-item-meta">${a(e.format||`bullet`)} · ${i(e.created_at)}</div>
            </div>
          </a>`).join(``))}var{data:{session:s}}=await e.auth.getSession();s&&o(s),e.auth.onAuthStateChange((e,t)=>{if(e===`SIGNED_IN`&&t&&o(t),e===`SIGNED_OUT`){let e=document.getElementById(`app-header`);e&&(e.style.display=`none`),document.getElementById(`landing-view`).style.display=`block`,document.getElementById(`dashboard-view`).style.display=`none`}});