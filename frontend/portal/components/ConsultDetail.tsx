"use client";

import type { ConsultDetail as ConsultDetailType } from '../lib/types';

type Props = {
  consult: ConsultDetailType;
};

export function ConsultDetail({ consult }: Props) {
  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
      {/* Header Card */}
      <div className="rounded-2xl border border-white/10 bg-black/40 p-6 backdrop-blur-md">
        <div className="flex flex-col gap-6 md:flex-row md:items-start md:justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
               <span className="inline-flex items-center rounded-md bg-blue-400/10 px-2 py-1 text-xs font-medium text-blue-400 ring-1 ring-inset ring-blue-400/20">CONSULT</span>
               <span className="text-xs text-slate-500 uppercase tracking-wider">{consult.id}</span>
            </div>
            <h1 className="text-3xl font-bold tracking-tight text-white mb-2">Pediatric Review Required</h1>
             <div className="flex items-center gap-4 text-sm text-slate-400">
                <span className="flex items-center gap-2">
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>
                    {consult.senderEmail ?? 'Unknown Sender'}
                </span>
                <span className="h-1 w-1 rounded-full bg-slate-700"></span>
                <span className="flex items-center gap-2">
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                    {new Date(consult.receivedAt).toLocaleString()}
                </span>
             </div>
          </div>
          
          <div className="flex flex-shrink-0 gap-3">
             <div className="text-right">
                <div className="text-sm font-medium text-slate-300">Priority Level</div>
                <div className="text-xs text-slate-500">Standard Triage</div>
             </div>
             <div className="h-10 w-10 rounded-full bg-emerald-500/10 flex items-center justify-center border border-emerald-500/20">
                <span className="text-emerald-500 text-lg font-bold">P2</span>
             </div>
          </div>
        </div>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        {/* Main Context - Left Col */}
        <div className="lg:col-span-2 space-y-6">
            {/* AI Summary */}
            <div className="rounded-2xl border border-white/5 bg-white/[0.02] p-6 hover:bg-white/[0.04] transition-colors">
                <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-pink-400">
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                    AI Pre-Analysis
                </h3>
                <div className="mt-4 rounded-xl bg-pink-500/5 border border-pink-500/10 p-4">
                    <p className="leading-relaxed text-slate-300">{consult.snippet || 'No automated analysis available for this case.'}</p>
                </div>
            </div>

            {/* Full Message Body */}
            <div className="rounded-2xl border border-white/5 bg-white/[0.02] p-6">
                 <h3 className="text-sm font-semibold uppercase tracking-wider text-slate-500">Clinical Notes / Transcript</h3>
                 <div className="mt-4 prose prose-invert max-w-none">
                    <p className="whitespace-pre-line text-slate-300 leading-7">{consult.payload.msgText || 'No text content provided.'}</p>
                 </div>
            </div>
        </div>

        {/* Sidebar Info - Right Col */}
        <div className="space-y-6">
             {/* Technical Stuff */}
             <div className="rounded-2xl border border-white/5 bg-black/20 p-5">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-4">Metadata</h3>
                <dl className="space-y-4">
                    <div>
                        <dt className="text-xs text-slate-500">Message Type</dt>
                        <dd className="mt-1 text-sm font-medium text-blue-400 font-mono">{(consult.msgType || consult.payload?.msgType || 'unknown').toUpperCase()}</dd>
                    </div>
                    <div>
                        <dt className="text-xs text-slate-500">Internal Ref</dt>
                        <dd className="mt-1 text-xs text-slate-400 font-mono overflow-hidden text-ellipsis">
                            {consult.convId}<br/>#{consult.msgId}
                        </dd>
                    </div>
                </dl>
             </div>

            {/* Attachments */}
             {consult.payload.attachment && (
                <div className="rounded-2xl border border-white/5 bg-black/20 p-5">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-4">Attachments</h3>
                    <div className="flex items-center gap-3 rounded-lg border border-white/10 bg-white/5 p-3 overflow-hidden">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-indigo-500/20 text-indigo-400">
                             <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                        </div>
                        <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium text-slate-200">{consult.payload.attachment.fileName}</p>
                            <p className="text-xs text-slate-500">{Math.round(consult.payload.attachment.fileSize / 1024)} KB</p>
                        </div>
                    </div>
                </div>
            )}
        </div>
      </div>
    </div>
  );
}
