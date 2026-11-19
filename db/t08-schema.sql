-- T08 비공개 영역 + 패스키 인증 스키마. Supabase SQL Editor에서 실행한다.
-- t08 스키마만 만들고 쓴다. 같은 프로젝트의 public(T06)·t07(T07)은 건드리지 않는다.
-- 여러 번 실행해도 되게 if not exists로 적는다.
create schema if not exists t08;
set search_path to t08;

-- 계정: 비밀번호 열이 없다. 아이디(영문·숫자)와 패스키로만 들어온다.
create table if not exists users (
  id         bigserial primary key,
  username    text not null check (username ~ '^[a-z0-9]{3,20}$'),
  -- WebAuthn user.id: 계정마다 무작위 32바이트(base64url). 아이디 없이 로그인할 때 인증기가 이 값을 돌려준다.
  user_handle text not null,
  created_at  timestamptz not null default now()
);
create unique index if not exists users_username_key on users (username);
create unique index if not exists users_user_handle_key on users (user_handle);

-- 패스키: 서버에는 공개키와 공개 메타데이터만 저장한다. 개인키 열은 없다(개인키는 인증기 밖으로 나오지 않는다).
create table if not exists passkeys (
  id            bigserial primary key,
  user_id       bigint not null references users (id) on delete cascade,
  credential_id text not null,                -- 자격 증명 ID(base64url)
  public_key    bytea not null,               -- COSE 형식 공개키
  sign_count    bigint not null default 0,    -- 인증기 서명 횟수(복제 탐지용)
  transports    text[] not null default '{}', -- internal / hybrid / usb 등
  aaguid        text not null,                -- 인증기 종류 ID(저장 위치 표시용)
  device_type   text not null check (device_type in ('singleDevice', 'multiDevice')),
  backed_up     boolean not null,             -- 비밀번호 관리자 등으로 동기화되었는지
  name          text not null check (length(name) between 1 and 60),
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);
create unique index if not exists passkeys_credential_id_key on passkeys (credential_id);
create index if not exists passkeys_user_idx on passkeys (user_id);

-- 일회용 챌린지: 서버가 만들어 보관하고, 검증할 때 한 번만 쓰고(used_at) 5분 뒤 만료된다.
create table if not exists challenges (
  id          bigserial primary key,
  challenge   text not null,                  -- 무작위 32바이트(base64url)
  purpose     text not null check (purpose in ('register', 'login')),
  user_id     bigint references users (id) on delete cascade, -- 로그인한 계정에 패스키를 추가할 때
  username    text,                           -- 새 계정 등록일 때 만들 아이디
  user_handle text,                           -- 새 계정 등록일 때 쓸 WebAuthn user.id
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz
);
create unique index if not exists challenges_challenge_key on challenges (challenge);

-- 로그인 세션: 쿠키 값(무작위 32바이트)은 DB에 두지 않고 SHA-256 해시만 둔다.
create table if not exists sessions (
  token_hash text primary key,
  user_id    bigint not null references users (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists sessions_user_idx on sessions (user_id);

-- 비공개 자료(가상의 내용). 종류: retro 회고 / project 프로젝트 메모 / apply 지원할 곳
-- 앱 역할에는 select·insert 권한만 준다 → 고치거나 지울 수 없다.
create table if not exists notes (
  id         bigserial primary key,
  user_id    bigint not null references users (id) on delete cascade,
  kind       text not null check (kind in ('retro', 'project', 'apply')),
  title      text not null check (length(title) between 1 and 100),
  body       text not null check (length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index if not exists notes_user_idx on notes (user_id, created_at);

alter table users    enable row level security;
alter table sessions enable row level security;
alter table notes    enable row level security;
alter table passkeys enable row level security;
alter table challenges enable row level security;

-- 앱 전용 역할 t08_app 권한 (t08-role.sql 1단계로 역할을 먼저 만든다)
do $$
declare t text;
begin
  execute 'alter role t08_app set search_path = t08';
  execute 'grant usage on schema t08 to t08_app';
  execute 'revoke all on all tables in schema t08 from t08_app';
  execute 'grant select, insert on all tables in schema t08 to t08_app';
  execute 'grant delete on t08.sessions to t08_app';
  execute 'grant update (sign_count, last_used_at, backed_up) on t08.passkeys to t08_app';
  execute 'grant delete on t08.passkeys to t08_app';   -- 카드 4: 패스키 삭제
  execute 'grant update (used_at) on t08.challenges to t08_app';
  execute 'grant delete on t08.challenges to t08_app';
  execute 'grant usage, select on all sequences in schema t08 to t08_app';
  foreach t in array array['users', 'sessions', 'notes', 'passkeys', 'challenges'] loop
    execute format('drop policy if exists t08_app_all on t08.%I', t);
    execute format('create policy t08_app_all on t08.%I for all to t08_app using (true) with check (true)', t);
  end loop;
end $$;
