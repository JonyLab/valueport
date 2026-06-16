-- 估值卡片：每张卡存进 items 行的 JSON 列；selected_valuation_id 指向被选作合理区间的卡。
ALTER TABLE items ADD COLUMN valuations TEXT NOT NULL DEFAULT '[]';
ALTER TABLE items ADD COLUMN selected_valuation_id TEXT;
