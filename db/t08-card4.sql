-- 카드 4: 패스키 삭제 권한. 이미 t08-schema.sql을 실행한 배포 DB에 이것만 추가로 실행한다.
-- (t08-schema.sql에도 같은 줄이 들어 있어 새로 만들 때는 따로 실행하지 않아도 된다)
grant delete on t08.passkeys to t08_app;

-- 확인: true여야 한다. 비공개 자료(notes)는 여전히 수정·삭제 불가(false)여야 한다.
select has_table_privilege('t08_app', 't08.passkeys', 'delete') as passkeys_delete,
       has_table_privilege('t08_app', 't08.notes', 'delete')    as notes_delete,
       has_table_privilege('t08_app', 't08.notes', 'update')    as notes_update;
