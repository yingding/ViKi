"use client";

import { useEffect, useState } from 'react';
import { ConsultList } from '../components/ConsultList';
import { ConsultDetail } from '../components/ConsultDetail';
import { VoiceConsole } from '../components/VoiceConsole';
import { useConsultDetail, useConsults } from '../lib/hooks';

export default function Home() {
  const { consults, isLoading: listLoading, isError: listError } = useConsults();
  const [selectedId, setSelectedId] = useState<string>('');
  const [showMobileList, setShowMobileList] = useState<boolean>(true); // Mobile view toggle
  const { consult, isLoading: detailLoading } = useConsultDetail(selectedId);

  useEffect(() => {
    if (!selectedId && consults.length > 0) {
      // Don't auto-switch view on mobile, just set ID background
      setSelectedId(consults[0].id);
    }
  }, [consults, selectedId]);

  const handleSelect = (id: string) => {
      setSelectedId(id);
      setShowMobileList(false); // Switch to detail view on mobile
  };

  const showDetail = Boolean(consult && !detailLoading);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-slate-900 via-[#0b1221] to-black">
      {/* Header */}
      <header className="flex h-14 lg:h-16 shrink-0 items-center justify-between border-b border-white/10 px-4 lg:px-6 backdrop-blur-md">
        <div className="flex items-center gap-2">
            <div className="h-6 w-6 lg:h-8 lg:w-8 rounded-lg bg-blue-600 shadow-[0_0_15px_rgba(37,99,235,0.5)]"></div>
            <h1 className="text-lg lg:text-xl font-bold tracking-tight text-white">ViKi <span className="hidden sm:inline font-light opacity-70">Specialist Portal</span></h1>
        </div>
        <div className="flex items-center gap-2 lg:gap-4">
             <div className={`h-1.5 w-1.5 lg:h-2 lg:w-2 rounded-full ${listError ? 'bg-gray-500' : 'bg-green-500 shadow-[0_0_10px_#22c55e]'}`}></div>
             <span className="text-[10px] lg:text-xs font-medium uppercase tracking-wider text-slate-400">
                {listError ? 'System Offline' : 'System Online'}
             </span>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex flex-1 overflow-hidden relative">
        {/* Sidebar: Consult List */}
        <aside className={`${showMobileList ? 'flex' : 'hidden'} w-full lg:flex lg:w-80 xl:w-96 flex-col shrink-0 overflow-y-auto border-r border-white/5 bg-black/20 backdrop-blur-sm`}>
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
                <ConsultList consults={consults} selectedId={selectedId} onSelect={handleSelect} />
                )}
            </div>
        </aside>

        {/* Main: Detail View */}
        <section className={`${!showMobileList ? 'flex' : 'hidden'} lg:flex w-full flex-1 flex-col overflow-hidden bg-white/[0.02] relative`}>
            
            {/* Mobile Back Button */}
            <div className="lg:hidden flex items-center p-2 border-b border-white/5 bg-white/5">
                <button 
                    onClick={() => setShowMobileList(true)}
                    className="flex items-center gap-2 text-sm text-slate-300 hover:text-white px-2 py-1"
                >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
                    Back to List
                </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 lg:p-6 scroll-smooth">
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
            
            {/* Voice Console */}
            <div className="shrink-0 border-t border-white/10 bg-[#0b1221]/90 p-3 lg:p-4 backdrop-blur-xl">
                <div className="mx-auto max-w-4xl">
                    <VoiceConsole consultId={selectedId} isOffline={Boolean(listError)} />
                </div>
            </div>
        </section>
      </main>
    </div>
  );
}
