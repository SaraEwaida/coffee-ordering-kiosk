import React from 'react';
import { Minus, Plus } from 'lucide-react';
export default function Stepper({value,onChange,min=0,max=20,compact=false}) {
  return <div className={`stepper ${compact?'small-stepper':''}`}>
    <button type="button" onClick={()=>onChange(Math.max(min,value-1))} disabled={value<=min} aria-label="Decrease"><Minus size={18}/></button>
    <strong aria-live="polite">{value}</strong>
    <button type="button" onClick={()=>onChange(Math.min(max,value+1))} disabled={value>=max} aria-label="Increase"><Plus size={18}/></button>
  </div>;
}
