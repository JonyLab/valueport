CREATE TABLE IF NOT EXISTS memory_spot_prices (
    id SERIAL PRIMARY KEY,
    crawl_date TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    product_type VARCHAR(50),
    spot_avg_price NUMERIC(10, 4),
    contract_price NUMERIC(10, 4),
    price_spread NUMERIC(10, 4)
);

CREATE INDEX IF NOT EXISTS idx_memory_spot_prices_product_date
    ON memory_spot_prices (product_type, crawl_date DESC);

CREATE TABLE IF NOT EXISTS taiwan_supply_chain_revenue (
    id SERIAL PRIMARY KEY,
    report_month VARCHAR(7),
    company_code VARCHAR(10),
    company_name VARCHAR(50),
    current_month_revenue NUMERIC(20, 2),
    mom_growth NUMERIC(6, 4),
    yoy_growth NUMERIC(6, 4),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (report_month, company_code)
);

CREATE INDEX IF NOT EXISTS idx_taiwan_revenue_company_month
    ON taiwan_supply_chain_revenue (company_code, report_month DESC);

CREATE TABLE IF NOT EXISTS memory_macro_indicators (
    id SERIAL PRIMARY KEY,
    record_date DATE,
    hbm_wafer_allocation_pct NUMERIC(5, 4),
    hbm_die_penalty NUMERIC(4, 2),
    gpu_lead_time_weeks INT
);
