-- Gateway network legs (VLAN sub-interfaces / extra NICs) managed from the dashboard.
ALTER TABLE sites ADD COLUMN network TEXT;
