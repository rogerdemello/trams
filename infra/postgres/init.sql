-- Runs once, on first container start, via docker-entrypoint-initdb.d.
--
-- POSTGRES_DB already creates `trams_user`, so only the second database needs
-- creating here.
--
-- Two databases rather than two schemas in one: each service must be able to
-- migrate, back up, and eventually move to its own server independently. A
-- shared database between microservices is precisely the coupling the broker
-- exists to remove — if the two services could join across each other's tables,
-- the event stream would be decoration.

CREATE DATABASE trams_notification OWNER trams;

COMMENT ON DATABASE trams_user IS
  'User Service: users, refresh_tokens, outbox_events. Written only by user-service.';
