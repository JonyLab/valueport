# Earnings research in valuation

The valuation workbench retrieves official company material on demand, with Longbridge news as supplementary evidence. There is no issuer allowlist or per-company IR adapter. Sources inform business questions, scenarios and parameter suggestions; financial inputs change only through the existing user confirmation actions.

## On-demand discovery

`GET /api/my/management-research?symbol=usSE&name=...` requires a signed-in session. Retrieval starts when AI research needs sources, rather than scanning all companies in advance.

1. Read the requested symbol's signed Longbridge `/v1/quote/comp-overview` response. Its `website` field establishes the starting company website; `company_name` and `name` supply issuer identity checks. No search result can establish a replacement company identity.
2. Fetch that website and follow actual investor-relations/quarterly-results links. An external IR platform needs an explicit Investor Relations link from the company site. Follow at most four directory pages. If configured, Tavily helps discover documents within the registered website's domain; its snippets never become evidence.
3. Inspect earnings-related anchors. For dynamically rendered directories, read up to two page-specific scripts and a referenced public financial/investor JSON endpoint. Downloaded JavaScript is never evaluated. JSON is traversed with depth/entry limits; explicit year/quarter values are discovery hints only.
4. Retrieve a bounded number of candidate PDF/HTML documents and check the original heading for both issuer identity and explicit reporting period. Prefer recent periods and call material. A catalog-period mismatch, future publication date, upcoming-results notice or missing issuer is rejected. Only the fetched original text becomes evidence.

This mechanism was tested live from Sea's profile website through its IR directory and public JSON catalog to its Q2 2026 prepared remarks PDF, without embedding a Sea URL or ticker in discovery code. Other websites may block automated requests or expose unsupported directory formats. Discovery failures are shown as gaps and cannot establish that the issuer issued no guidance.

## Request and extraction limits

Existing server-side `LONGBRIDGE_*` credentials authenticate company-profile and news requests. Only public company identifiers go to search; forms, account data and conversations are not sent. Tavily is optional and uses the existing server-side key.

Official discovery has an 18-second cooperative deadline and at most 18 HTTP requests, including redirects. Redirect destinations are checked individually. Website HTML is limited to 1,024,000 bytes, script/JSON directories to 512,000 bytes, and source PDFs to 4 MiB. PDF extraction uses the serverless `unpdf` build, rejects more than 40 pages or 200,000 extracted characters, checks cancellation between pages and destroys each document after parsing. It does not execute PDF actions or load remote font resources. Image-only PDFs/OCR, arbitrary browser execution and complete multilingual layout reconstruction are outside the current extractor.

Company and IR hosts are discovered from the signed company profile and actual website links. An external PDF CDN must be linked from a fetched company/IR page. Public HTTPS URLs exclude credentials, custom ports, IP literals and local/internal hosts. Client snapshots cannot instruct the retrieval API to fetch a supplied URL: that API accepts only symbol and public company name. Snapshot metadata is attribution, not independent verification of client-submitted content.

Successful snapshots also persist in D1, keyed by company symbol rather than display name. The service checks the six-hour edge cache first, then durable storage. A fresh durable snapshot is returned without upstream requests even after edge-cache eviction or a Worker restart. Browser responses remain `no-store`.

After six hours, the saved snapshot is returned immediately with a `refreshing` label while `waitUntil` checks for updates in the background. An atomic per-symbol D1 lease prevents concurrent visitors from triggering duplicate refreshes. Successful refreshes replace the current snapshot; failures retain the last successful material, record the check time and wait ten minutes before retrying. News-only or older-period results cannot overwrite newer saved official evidence. Expired news is removed when durable snapshots are read. An initial empty/failed retrieval does not replace a successful record.

Discovered IR entries are reused when the signed company profile still lists the same website. Fetched official documents persist as original extracted text by page, source URL, format, publication date and retrieval time. The same URL reuses this text for up to 24 hours, avoiding both download and PDF parsing; after that it is fetched again to allow corrections to be detected. New document URLs are fetched normally. This stores extracted text and provenance, not original PDF binaries or user assumptions. The source's `retrievedAt` remains the original retrieval time when text is reused.

The additive `management_research_snapshots` and `management_research_documents` definitions are in `schema.sql` and are initialized on first use for existing databases. Storage failures fall back to the ordinary retrieval/edge-cache path. Opening a historical valuation/draft retains its saved sources so earlier assumptions remain reviewable; a new research session retrieves or reuses the current server snapshot.

## Evidence and valuation boundaries

An empty/failed browser draft snapshot is retried when the editor reopens, including when a restored question needs no new AI request. Empty panels expose a manual retry. Concurrent requests share one in-flight attempt; automatic failure retries are throttled for one minute, while explicit retry remains available. Recovered evidence is saved into both editor and guide state without changing answers or per-question historical references. Successful cited snapshots stay frozen for reproducibility.

The snapshot preserves the discovered company website and IR entry, issuer name, source URL, file/report period, known file/publication date, document type and PDF page count. Official passages retain speaker labels when explicitly present, section and original page number. HTML excerpts have no invented page numbers. Fiscal-year periods retain `FY`; publication dates do not establish call dates.

At most three sources are returned, official evidence first. Official documents contribute up to six 650-character original excerpts; news contributes up to three each. Labels distinguish company outlook, official management statements/company disclosures, reported management views, analyst opinion and mixed attribution. Labels are conservative initial classifications. Prepared remarks are distinguished from a complete call, with Q&A coverage recorded as included, not included or unknown. An announced Q&A session does not prove its answers are in the document.

Management outlook remains a forecast even in an official document. Short-term guidance cannot directly become a multi-year CAGR or terminal assumption. Suggested parameters must explain source (`M1`–`M3`) → the user's conditional business judgment → applicable period and financial mechanism → suggested value and limitations. Capital spending must account for reinvestment and cash generation. Official and news sources stay separate from `verified` financial facts.

Sources are preserved through guide references, narrative/method/parameter prompts, drafts, AI replies and the saved valuation card's `managementResearch` field. Older news-only snapshots and cards without research remain compatible. No automatic scenario-input adjustment or deployment is part of retrieval.

## News fallback

Longbridge's recent symbol-news list, optional name search and one related-article discovery page remain available in parallel. Final excerpts come from signed article detail, never public discovery snippets. Related/search articles require ticker or title-company matching. News older than 120 days is excluded. Requests have a separate 12-second deadline and 256 KB response limits. This is recent/related coverage and cannot claim to completely cover the latest reporting period.

## Validation

Core tests cover an unregistered ticker's dynamic website discovery, linked IR/CDN provenance, optional search boundaries, JSON directory discovery without script execution, HTML and PDF extraction, fiscal periods, issuer/period mismatch, Q&A boundaries, size/page limits, graceful fallback and source snapshot compatibility. Worker tests exercise the actual PDF parser as well as route authentication and caching. Live checks distinguish successful official retrieval from blocked sites; a source-panel UI fixture uses real source metadata rather than claiming live model validation.

Persistent-storage tests use real D1 bindings to verify reuse after edge eviction/across handler instances, immediate stale responses before refresh completion, concurrent refresh exclusion, failure retention and retry throttling, period downgrade protection, text persistence/expiry, symbol isolation and storage-unavailable fallback. A discovery integration test verifies that a second run reuses both the IR entry and saved page text without downloading or parsing the PDF again.

Primary references: Longbridge's official `longbridge-terminal`/`openapi` implementations for signed news routes; the installed `unpdf` documentation/serverless PDF.js build; Cloudflare Workers streams and runtime documentation. The signed company-profile `website` field was verified live for Sea, TSMC and Apple.
