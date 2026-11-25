'use strict';

// Strict day-based subset of RFC 5545. No silent fallback to a different rule.
const DAY=86400000;
const WEEKDAYS=['SU','MO','TU','WE','TH','FR','SA'];
const MAX_INSTANCES=5000, MAX_PERIODS=100000, MAX_DAYS=200000;
function expandRule(line, start, baseAt, duration, {dateLine, unsupported, now=Date.now()}={}) {
  const bad=()=>unsupported('RRULE',true);
  if(!/^RRULE:/i.test(line)||line.length>4096) bad();
  const fields=new Map();
  for(const part of line.slice(6).toUpperCase().split(';')) {
    const m=/^([A-Z]+)=([A-Z0-9,+-]+)$/.exec(part);
    if(!m||fields.has(m[1])||!['FREQ','COUNT','UNTIL','INTERVAL','WKST','BYDAY','BYMONTHDAY','BYMONTH','BYSETPOS'].includes(m[1])) bad();
    fields.set(m[1],m[2]);
  }
  const freq=fields.get('FREQ');
  if(!['DAILY','WEEKLY','MONTHLY','YEARLY'].includes(freq)||fields.has('COUNT')&&fields.has('UNTIL')) bad();
  function positive(key,max,fallback) {
    if(!fields.has(key)) return fallback;
    const v=fields.get(key); if(!/^\d{1,9}$/.test(v)||+v<1||+v>max) bad(); return +v;
  }
  function numbers(key,min,max) {
    if(!fields.has(key))return [];
    const out=fields.get(key).split(',').map(v=>{if(!/^[+-]?\d{1,3}$/.test(v)||+v<min||+v>max||+v===0)bad();return +v;});
    return [...new Set(out)];
  }
  const interval=positive('INTERVAL',366,1), count=positive('COUNT',MAX_INSTANCES,null);
  const months=numbers('BYMONTH',1,12), monthDays=numbers('BYMONTHDAY',-31,31), positions=numbers('BYSETPOS',-366,366);
  const wkst=WEEKDAYS.indexOf(fields.get('WKST')||'MO'); if(wkst<0)bad();
  const weekdays=fields.has('BYDAY')?fields.get('BYDAY').split(',').map(v=>{
    const m=/^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(v);
    if(!m||m[1]&&(+m[1]===0||Math.abs(+m[1])>53||!['MONTHLY','YEARLY'].includes(freq)))bad();
    return {day:WEEKDAYS.indexOf(m[2]),ordinal:m[1]?+m[1]:0};
  }):[];
  if(freq==='WEEKLY'&&monthDays.length||positions.length&&!(months.length||monthDays.length||weekdays.length))bad();
  const dateKey=d=>Date.UTC(+d.slice(0,4),+d.slice(4,6)-1,+d.slice(6,8));
  const baseDay=dateKey(start.date), baseDate=new Date(baseDay), baseMonth=baseDate.getUTCMonth()+1, baseDom=baseDate.getUTCDate();
  const h=+(start.clock||'000000').slice(0,2), m=+(start.clock||'000000').slice(2,4), s=+(start.clock||'000000').slice(4,6);
  const clockMs=(h*3600+m*60+s)*1000;
  const tz=start.parameter.toUpperCase().startsWith('TZID=')?start.parameter.slice(5).replace(/^"|"$/g,''):start.utc?'UTC':Intl.DateTimeFormat().resolvedOptions().timeZone;
  const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  function wallAt(epoch){const p=Object.fromEntries(formatter.formatToParts(epoch).map(x=>[x.type,x.value]));return Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second);}
  function epochAt(day,clock=clockMs){
    const wall=day+clock;
    if(tz==='UTC')return wall;
    // Both offsets around a transition; choose first of ambiguous instants.
    const offsets=new Set([wall-DAY,wall,wall+DAY].map(t=>wallAt(t)-t));
    const valid=[...offsets].map(offset=>wall-offset).filter(t=>wallAt(t)===wall);
    return valid.length?Math.min(...valid):null;
  }
  if(epochAt(baseDay)!==baseAt)bad();
  let until=null, untilDay=null;
  if(fields.has('UNTIL')){
    const raw=fields.get('UNTIL');
    const u=dateLine('DTSTART:'+raw);
    if(u.allDay!==start.allDay||!u.allDay&&u.utc!==Boolean(start.utc||start.parameter.toUpperCase().startsWith('TZID=')))bad();
    untilDay=dateKey(u.date);
    const uc=u.clock||'000000'; const ms=(+uc.slice(0,2)*3600+ +uc.slice(2,4)*60+ +uc.slice(4,6))*1000;
    until=u.allDay?untilDay:u.utc?untilDay+ms:epochAt(untilDay,ms);
    if(until===null||(u.allDay?untilDay<baseDay:until<baseAt))bad();
  }
  const finite=count!==null||until!==null;
  const low=new Date(now),high=new Date(now);
  low.setUTCFullYear(low.getUTCFullYear()-3);high.setUTCFullYear(high.getUTCFullYear()+10);
  const lower=finite?-Infinity:low.getTime(), upper=finite?Infinity:high.getTime();
  const result=[];let generated=0, work=0, first=true;
  const monthStart=(y,mon)=>Date.UTC(y,mon,1);
  const weekStart=baseDay-((baseDate.getUTCDay()-wkst+7)%7)*DAY;
  function period(step){
    if(freq==='DAILY'){const d=baseDay+step*interval*DAY;return [d,d+DAY];}
    if(freq==='WEEKLY'){const d=weekStart+step*interval*7*DAY;return [d,d+7*DAY];}
    if(freq==='MONTHLY'){const n=baseDate.getUTCMonth()+step*interval;return [monthStart(baseDate.getUTCFullYear(),n),monthStart(baseDate.getUTCFullYear(),n+1)];}
    const y=baseDate.getUTCFullYear()+step*interval;return [monthStart(y,0),monthStart(y+1,0)];
  }
  function candidate(t){
    const d=new Date(t), year=d.getUTCFullYear(), mon=d.getUTCMonth()+1, dom=d.getUTCDate(), day=d.getUTCDay();
    const dim=new Date(Date.UTC(year,mon,0)).getUTCDate();
    if(months.length&&!months.includes(mon))return false;
    if(monthDays.length&&!monthDays.some(n=>n===dom||n<0&&dim+n+1===dom))return false;
    if(weekdays.length&&!weekdays.some(w=>{
      if(w.day!==day)return false;if(!w.ordinal)return true;
      const yearly=freq==='YEARLY'&&!months.length;
      const firstDay=yearly?Date.UTC(year,0,1):Date.UTC(year,mon-1,1);
      const lastDay=yearly?Date.UTC(year+1,0,0):Date.UTC(year,mon,0);
      return w.ordinal>0?Math.floor((t-firstDay)/DAY/7)+1===w.ordinal:-(Math.floor((lastDay-t)/DAY/7)+1)===w.ordinal;
    }))return false;
    if(freq==='WEEKLY'&&!weekdays.length&&day!==baseDate.getUTCDay())return false;
    if(['MONTHLY','YEARLY'].includes(freq)&&!monthDays.length&&!weekdays.length&&dom!==baseDom)return false;
    if(freq==='YEARLY'&&!months.length&&!monthDays.length&&!weekdays.length&&mon!==baseMonth)return false;
    return true;
  }
  // Date-based bound allows stopping even for rules with no candidates.
  const stopDay=count!==null?Infinity:until!==null?untilDay+2*DAY:upper+2*DAY;
  for(let step=0;step<MAX_PERIODS;step++){
    const [from,to]=period(step);
    if(!Number.isFinite(from)||!Number.isFinite(to)||new Date(from).getUTCFullYear()>9998)bad();
    if(from>stopDay){if(first)bad();return result;}
    const candidates=[];
    for(let t=from;t<to;t+=DAY){
      if(++work>MAX_DAYS)bad();
      if(!candidate(t))continue;
      // Invalid local recurrence times are excluded before COUNT/BYSETPOS.
      // Avoid projecting past candidates for endless rules unless needed for
      // the first period (DTSTART validation) or for a long event overlap.
      if(!finite&&!first&&to<lower-duration-2*DAY)continue;
      const at=epochAt(t);if(at!==null)candidates.push({day:t,at});
    }
    const selected=positions.length?[...new Set(positions.map(n=>candidates[n>0?n-1:candidates.length+n]).filter(Boolean))].sort((a,b)=>a.day-b.day):candidates;
    if(first){if(!selected.some(x=>x.at===baseAt))bad();first=false;}
    for(const c of selected){
      if(c.at<baseAt)continue;
      if(until!==null&&(start.allDay?c.day>untilDay:c.at>until))return result;
      generated++;
      if(c.at+duration>=lower&&c.at<=upper){if(result.length>=MAX_INSTANCES)bad();result.push(c);}
      if(count!==null&&generated===count)return result;
    }
  }
  return bad();
}
module.exports={expandRule};
