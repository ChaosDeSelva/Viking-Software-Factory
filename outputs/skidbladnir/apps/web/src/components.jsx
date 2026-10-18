import React from 'react';
export function Button({children, tone='', ...props}) { return <button className={`button ${tone}`} {...props}>{children}</button>; }
export function Badge({children}) { return <span className={`badge ${children}`}>{children}</span>; }
export function Panel({title, children, extra}) { return <section className="panel"><div className="panel-head"><h2>{title}</h2>{extra}</div>{children}</section>; }
export function Field({label,children}) { return <label className="field"><span>{label}</span>{children}</label>; }
export function Metric({label,value,note}) { return <div className="metric"><span>{label}</span><strong>{value}</strong><small>{note}</small></div>; }
export function Empty({children}) { return <div className="empty">{children}</div>; }

export function Icon({name}) {
  const paths = {
    fleet: <><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></>,
    plus: <path d="M12 5v14M5 12h14"/>,
    history: <><path d="M8 6h12M8 12h12M8 18h12"/><path d="M4 6h.01M4 12h.01M4 18h.01"/></>,
    worker: <><rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.01M7 17h.01M16 7h2M16 17h2"/></>
  };
  return <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
