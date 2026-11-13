-- Secret rotation overlap: keep the previous signing secret so receivers can
-- verify in-flight deliveries during a rotation window.
ALTER TABLE endpoints ADD COLUMN IF NOT EXISTS signing_secret_previous TEXT;
