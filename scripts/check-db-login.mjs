// t08_app 비밀번호가 Supabase에 제대로 들어갔는지 내 PC에서 확인한다.
// 실행: node scripts/check-db-login.mjs  → 비밀번호를 물으면 붙여넣고 Enter (화면에 표시되지 않음)
// 비밀번호는 파일·화면·기록에 남기지 않는다.
import postgres from 'postgres';

const HOST = 'aws-1-ap-northeast-2.pooler.supabase.com';
const USER = 't08_app.tdyzcxrerphpamyukaan';

function askHidden(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    let value = '';
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (ch) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode?.(false); stdin.pause(); stdin.off('data', onData);
          process.stdout.write('\n'); return resolve(value);
        }
        if (c === '\u0003') process.exit(1);           // Ctrl+C
        if (c === '\u007f' || c === '\b') value = value.slice(0, -1);
        else value += c;
      }
    };
    stdin.on('data', onData);
  });
}

const pw = (await askHidden('t08_app 비밀번호 (붙여넣기 후 Enter, 표시되지 않음): ')).trim();
console.log(`입력 길이 ${pw.length}자, 영문·숫자만: ${/^[A-Za-z0-9]+$/.test(pw) ? '예' : '아니오 (특수문자는 DATABASE_URL에서 변환이 필요)'}`);
// 값은 보이지 않게 하고, 글자 종류만 센다(한글 입력 상태·보이지 않는 문자 확인용)
const kinds = { 소문자: 0, 대문자: 0, 숫자: 0, 한글: 0, 보이지않는문자: 0, 기타기호: 0 };
for (const c of pw) {
  if (/[a-z]/.test(c)) kinds.소문자++;
  else if (/[A-Z]/.test(c)) kinds.대문자++;
  else if (/[0-9]/.test(c)) kinds.숫자++;
  else if (/[ᄀ-ᇿ㄰-㆏가-힣]/.test(c)) kinds.한글++;
  else if (/[\u0000-\u001f\u007f-\u009f​-‏﻿]/.test(c)) kinds.보이지않는문자++;
  else kinds.기타기호++;
}
console.log('글자 종류:', Object.entries(kinds).map(([k, n]) => `${k} ${n}`).join(', '));
// 같은 비밀번호로 세 경로를 시도한다: 풀러 transaction(6543, Vercel이 쓰는 곳) / 풀러 session(5432) / DB 직접(5432)
const targets = [
  { name: '풀러 transaction 6543 (Vercel)', host: HOST, port: 6543, username: USER },
  { name: '풀러 session 5432', host: HOST, port: 5432, username: USER },
  { name: 'DB 직접 5432', host: 'db.tdyzcxrerphpamyukaan.supabase.co', port: 5432, username: 't08_app' },
];
for (const t of targets) {
  const s = postgres({ host: t.host, port: t.port, database: 'postgres', username: t.username, password: pw, prepare: false, max: 1, connect_timeout: 10 });
  try {
    const [r] = await s`select current_user as db_role, current_setting('search_path') as search_path`;
    console.log(`[${t.name}] 접속 성공: db_role=${r.db_role}, search_path=${r.search_path}`);
  } catch (e) {
    console.log(`[${t.name}] 접속 실패: ${e.code || ''} ${e.message}`);
  } finally {
    await s.end({ timeout: 5 }).catch(() => {});
  }
}
