-- Payments move from Paddle to Stripe. Provider ids get provider-neutral column names, so a later switch of payment
-- provider changes the adapter, not the schema. Values are kept: locally they are seed or fake ids anyway.
ALTER TABLE plan_prices RENAME COLUMN paddle_price_id TO provider_price_id;
ALTER TABLE subscriptions RENAME COLUMN paddle_price_id TO provider_price_id;
ALTER TABLE subscriptions RENAME COLUMN paddle_customer_id TO provider_customer_id;
ALTER TABLE subscriptions RENAME COLUMN paddle_subscription_id TO provider_subscription_id;
ALTER TABLE subscription_events RENAME COLUMN paddle_event_id TO provider_event_id;
ALTER TABLE credit_grants RENAME COLUMN paddle_transaction_id TO provider_transaction_id;
ALTER TABLE coupon_plan_rules RENAME COLUMN paddle_discount_id TO provider_discount_id;
ALTER TABLE coupon_redemptions RENAME COLUMN paddle_transaction_id TO provider_transaction_id;
ALTER TABLE coupon_redemptions RENAME COLUMN paddle_subscription_id TO provider_subscription_id;
