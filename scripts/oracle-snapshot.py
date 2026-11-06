"""Emit SQL*Plus input for a verified Book Studio snapshot import.

Run with an Oracle DBA in the dedicated PDB. Treat output as manuscript data.
"""
import hashlib
import json
import pathlib
import sqlite3
import sys

TABLES = {
    "books": ("id",),
    "characters": ("book_id", "id"),
    "chapters": ("book_id", "number"),
}


def sql_bytes(value):
    return value.encode("utf-8").hex()


def main():
    source = pathlib.Path(sys.argv[1]).resolve()
    snapshot = hashlib.sha256(source.read_bytes()).hexdigest()
    with sqlite3.connect(source.as_uri() + "?mode=ro&immutable=1", uri=True) as db:
        db.row_factory = sqlite3.Row
        if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise RuntimeError("SQLite snapshot integrity check failed")
        if db.execute("PRAGMA foreign_key_check").fetchone():
            raise RuntimeError("SQLite snapshot has foreign key violations")
        rows = [
            (table, [dict(row) for row in db.execute(
                f"SELECT * FROM {table} ORDER BY {', '.join(keys)}"
            )])
            for table, keys in TABLES.items()
        ]

    print("""whenever sqlerror exit failure rollback
whenever oserror exit failure rollback
set define off feedback off serveroutput on
alter session set container=FREEPDB1;
declare
  found number;
begin
  select count(*) into found from dba_users where username = 'ZDX_BOOK_STUDIO_SNAPSHOT';
  if found = 0 then
    execute immediate 'create user ZDX_BOOK_STUDIO_SNAPSHOT no authentication default tablespace USERS quota 64M on USERS';
  end if;
  select count(*) into found from dba_tables
    where owner = 'ZDX_BOOK_STUDIO_SNAPSHOT' and table_name = 'SNAPSHOT_ROWS';
  if found = 0 then
    execute immediate 'create table ZDX_BOOK_STUDIO_SNAPSHOT.SNAPSHOT_ROWS (
      snapshot_id varchar2(64) not null, entity varchar2(16) not null,
      entity_key varchar2(512) not null, payload clob not null check (payload is json),
      primary key (snapshot_id, entity, entity_key))';
  end if;
end;
/
""")
    for table, table_rows in rows:
        for row in table_rows:
            key = json.dumps([row[k] for k in TABLES[table]], ensure_ascii=True)
            payload = json.dumps(row, ensure_ascii=False, separators=(",", ":"))
            print("declare payload_clob clob; stored_clob clob; part varchar2(4000); begin")
            print("dbms_lob.createtemporary(payload_clob, true);")
            for offset in range(0, len(payload), 400):
                chunk = sql_bytes(payload[offset:offset + 400])
                print(f"part := utl_i18n.raw_to_char(hextoraw('{chunk}'), 'AL32UTF8');")
                print("dbms_lob.writeappend(payload_clob, length2(part), part);")
            safe_key = key.replace("'", "''")
            where = f"snapshot_id='{snapshot}' and entity='{table}' and entity_key='{safe_key}'"
            print(f"""begin
  insert into ZDX_BOOK_STUDIO_SNAPSHOT.SNAPSHOT_ROWS
    values ('{snapshot}', '{table}', '{safe_key}', payload_clob);
exception when dup_val_on_index then null;
end;
select payload into stored_clob from ZDX_BOOK_STUDIO_SNAPSHOT.SNAPSHOT_ROWS where {where};
if dbms_lob.compare(payload_clob, stored_clob) <> 0 then
  raise_application_error(-20001, 'Snapshot payload mismatch');
end if;
dbms_lob.freetemporary(payload_clob);
end;
/""")
        print(f"""declare actual number; begin
select count(*) into actual from ZDX_BOOK_STUDIO_SNAPSHOT.SNAPSHOT_ROWS
where snapshot_id='{snapshot}' and entity='{table}';
if actual <> {len(table_rows)} then raise_application_error(-20002, 'Snapshot count mismatch'); end if;
dbms_output.put_line('{table}: ' || actual);
end;
/""")
    print("commit;\nexit success")


if __name__ == "__main__":
    main()
