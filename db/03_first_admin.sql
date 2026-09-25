-- Optional: add admins from SQL. Root owners can also be set with ADMIN_ADDRESSES in backend/.env
-- (env owners can never be removed from the panel). Addresses must be lowercase.
insert into app.admins (address, role, added_by)
values ('0xyour_wallet_address_in_lowercase_________', 'owner', 'sql')
on conflict (address) do update set role = excluded.role;
