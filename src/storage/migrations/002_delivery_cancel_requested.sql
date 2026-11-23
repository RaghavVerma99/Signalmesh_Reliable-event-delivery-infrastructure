-- Cooperative cancellation for in-flight deliveries. The worker checks this
-- flag after an attempt completes and refuses to schedule another retry once
-- an operator has cancelled the delivery.
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS cancel_requested BOOLEAN NOT NULL DEFAULT false;
