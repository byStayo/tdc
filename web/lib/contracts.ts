export type DataStatus = 'ok' | 'partial' | 'unavailable' | 'unconfigured' | 'unauthorized' | 'rate_limited' | 'stale';
export interface Envelope<T> { status: DataStatus; source: string; asOf: string | null; fetchedAt: string; data: T; message?: string; coverage?: string; }
export interface Quote { symbol: string; name: string; close: number; open: number; high: number; low: number; volume: number; change: number | null; changePercent: number | null; asOf: string; }
export interface Bar { time: string; open: number; high: number; low: number; close: number; volume: number; }
export interface NewsItem { id: string; title: string; description: string; url: string; publisher: string; publishedAt: string; symbols: string[]; sentiment: 'positive' | 'negative' | 'neutral' | null; reasoning?: string; }
export interface OptionContract { symbol: string; type: 'call'|'put'; strike: number; expiry: string; price: number|null; volume: number|null; openInterest: number|null; iv: number|null; delta: number|null; gamma: number|null; }
export interface Company { symbol: string; name: string; description: string; homepage: string|null; marketCap: number|null; employees: number|null; exchange: string|null; sector: string|null; }
export interface Indicator { id: string; name: string; value: number|null; unit: string; interpretation: string; methodology: string; }
export interface ResearchItem { id: string; title: string; excerpt: string; url: string; publishedAt: string; author: string; }
export interface SourceState { id: string; name: string; status: DataStatus; description: string; url: string; asOf: string|null; }
export interface MacroSeries { id: string; name: string; unit: string; frequency: 'daily'|'monthly'|'quarterly'; url: string; observations: {date:string; value:number}[]; }
export interface Filing { id:string; company:string; cik:string; form:string; filedAt:string; reportDate:string|null; url:string; description:string; }
export interface Positioning { id:string; market:string; contractCode:string; reportDate:string; units:string; openInterest:number|null; assetManagerLong:number|null; assetManagerShort:number|null; leveragedLong:number|null; leveragedShort:number|null; dealerLong:number|null; dealerShort:number|null; }
export interface Workspace { symbol: string; fetchedAt: string; market: {state: string; asOf: string|null}; quotes: Envelope<Quote[]>; history: Envelope<Bar[]>; news: Envelope<NewsItem[]>; options: Envelope<OptionContract[]>; company: Envelope<Company|null>; indicators: Indicator[]; archive: ResearchItem[]; sources: SourceState[]; macro?: Envelope<MacroSeries[]>; mode?:'public'|'private'; filings?:Envelope<Filing[]>; positioning?:Envelope<Positioning[]>; }
export interface ResearchBrief { headline: string; summary: string; bull: {text: string; sourceIds: string[]}[]; bear: {text: string; sourceIds: string[]}[]; watch: {text: string; sourceIds: string[]}[]; limitations: string[]; }
export interface ResearchResponse { status: DataStatus; data: ResearchBrief|null; model?: string; createdAt?: string; message?: string; sources?: {id:string; title:string;url:string}[]; scope?:'market'|'instrument'; }
