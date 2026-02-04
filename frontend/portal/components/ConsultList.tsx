"use client";

import clsx from 'clsx';
import type { ConsultSummary } from '../lib/types';

type Props = {
  consults: ConsultSummary[];
  selectedId: string;
  onSelect: (id: string) => void;
};

export function ConsultList({ consults, selectedId, onSelect }: Props) {
  console.log(`[ConsultList] Rendering ${consults.length} items`);
  return (
    <div className="space-y-2">
      {consults.map((consult) => (
        <button
          key={consult.id}
          type="button"
          className={clsx(
            'group relative w-full text-left rounded-xl border p-4 transition-all duration-200 focus:outline-none',
            selectedId === consult.id
              ? 'bg-blue-600/10 border-blue-500/50 ring-1 ring-blue-500/50'
              : 'bg-white/[0.03] border-white/5 hover:bg-white/[0.07] hover:border-white/10'
          )}
          onClick={() => onSelect(consult.id)}
        >
          <div className="flex items-start justify-between gap-2">
             <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                    <div className={clsx("h-2 w-2 rounded-full", String(consult.msgType).toLowerCase() === 'urgent' ? 'bg-red-500 shadow-red-500/50 shadow-[0_0_8px]' : 'bg-blue-400')}></div>
                    <p className={clsx("truncate text-sm font-medium", selectedId === consult.id ? "text-blue-100" : "text-slate-200")}>
                        {consult.senderEmail ?? 'Unknown sender'}
                    </p>
                </div>
                <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-slate-400 group-hover:text-slate-300">
                    {consult.snippet || 'No preview available.'}
                </p>
             </div>
          </div>
          <div className="mt-3 flex items-center justify-between border-t border-white/5 pt-2 text-[10px] uppercase tracking-wider font-medium text-slate-500">
             <span>{new Date(consult.receivedAt).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
             <span className={clsx(selectedId === consult.id ? 'text-blue-400' : 'text-slate-500')}>{consult.msgType}</span>
          </div>
        </button>
      ))}
    </div>
  );
}
