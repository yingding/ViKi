"use client";

import { useEffect, useState } from 'react';
import { ConsultList } from '../components/ConsultList';
import { ConsultDetail } from '../components/ConsultDetail';
import { VoiceConsole } from '../components/VoiceConsole';
import { useConsultDetail, useConsults } from '../lib/hooks';

export default function Home() {
  const { consults, isLoading: listLoading, isError: listError } = useConsults();
  const [selectedId, setSelectedId] = useState<string>('');
  const { consult, isLoading: detailLoading } = useConsultDetail(selectedId);

  useEffect(() => {
    if (!selectedId && consults.length > 0) {
      setSelectedId(consults[0].id);
    }
  }, [consults, selectedId]);

  const showDetail = Boolean(consult && !detailLoading);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-slate-900 via-[#0b1221] to-black">
      {/* Header */}
      <header className="flex h-16 shrink-0 items-center justify-between border-b border-white/10 px-6 backdrop-blur-md">
        <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-blue-600 shadow-[0_0_15px_rgba(37,99,235,0.5)]"></div>
            <h1 className="text-xl font-bold tracking-tight text-white">ViKi <span className="font-light opacity-70">Specialist Portal</span></h1>
        </div>
        <div className="flex items-center gap-4">
             <div className="h-2 w-2 rounded-full bg-green-500 shadow-[0_0_10px_#22c55e]"></div>
             <span className="text-xs font-medium uppercase tracking-wider text-slate-400">System Online</span>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex flex-1 overflow-hidden">
        {/* Sidebar: Consult List */}
        <aside className="w-80 shrink-0 overflow-y-auto border-r border-white/5 bg-black/20 backdrop-blur-sm lg:w-96">
            <div className="sticky top-0 z-10 border-b border-white/5 bg-[#0b1221]/80 px-4 py-3 backdrop-blur-md">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400">Incoming Consults</h2>
            </div>
            <div className="p-4">
                {listError && <p className="px-4 text-sm text-red-400">Unable to load consults.</p>}
                {listLoading && consults.length === 0 ? (
                <div className="space-y-3 px-4">
                    {[1,2,3].map(i => <div key={i} className="h-24 animate-pulse rounded-xl bg-white/5"></div>)}
                </div>
                ) : (
                <ConsultList consults={consults} selectedId={selectedId} onSelect={setSelectedId} />
                )}
            </div>
        </aside>

        {/* Main: Detail View */}
        <section className="relative flex flex-1 flex-col overflow-hidden bg-white/[0.02]">
            <div className="flex-1 overflow-y-auto p-6 scroll-smooth">
                {showDetail && consult ? (
                <div className="mx-auto max-w-4xl space-y-6">
                    <ConsultDetail consult={consult} />
                </div>
                ) : (
                <div className="flex h-full flex-col items-center justify-center text-center text-slate-600">
                    <div className="mb-4 rounded-full bg-white/5 p-4">
                        <svg className="h-8 w-8 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                    </div>
                    <p>{detailLoading ? 'Loading details...' : 'Select a consult from the list to review.'}</p>
                </div>
                )}
            </div>
            
            {/* Voice Console - Sticky Bottom or integrated? 
                Let's make it a floating panel at the bottom center or fixed bottom bar.
                Actually, keeping it structured at the bottom of the main view is good. 
            */}
            <div className="shrink-0 border-t border-white/10 bg-[#0b1221]/90 p-4 backdrop-blur-xl">
                <div className="mx-auto max-w-4xl">
                    <VoiceConsole consultId={selectedId} />
                </div>
            </div>
        </section>
      </main>
    </div>
  );
}
