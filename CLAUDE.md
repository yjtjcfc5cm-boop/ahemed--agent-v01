# NEXUS ONE — Current scope override (2026-10-21)

For NEXUS work, read [the authoritative current plan](docs/NEXUS_SCENE_FIRST_PLAN.md) first. Ahmed requires a purchased ready-made cinematic scene as the world foundation and explicitly authorizes parallel implementation of the main agent, integrations and specialist agents now. Backend work does not wait for purchase. Do not build the world from scratch or replace it with a dashboard. The historical v0.1 scope, BUILD_PROMPT precedence, no-subagents and no-connectors restrictions below do not override this NEXUS instruction. Preserve applicable security invariants and existing work. Asset payment requires approval of the specific asset and price. Old scheduled automations remain stopped.

---
## Historical v0.1 instructions

# CLAUDE.md — AHMED Agent

يُقرأ هذا الملف في بداية كل جلسة. التزم به دائمًا.

## المشروع
- AHMED Agent: وكيل شخصي لأحمد. النسخة الحالية v0.1 هدفها Vertical Slice واحد فقط يعمل من تطبيق الجوال حتى التنفيذ والتحقق والنتيجة.
- المعمارية: Ahmed App → Core API → Agent Core + State Machine → Model / Tools
- التطبيق (apps/mobile) واجهة إدخال وعرض فقط: لا منطق وكيل، ولا اتصال بمزود النموذج، ولا مفاتيح نماذج.
- الـCore (apps/core) يملك الحالة والقرار والصلاحيات والتدقيق.
- n8n غير مربوط في v0.1.

## المراجع
- docs/BUILD_PROMPT.md: أمر البناء الحاكم لنطاق v0.1.
- V0_CONTRACT.md: العقد بين التطبيق والـCore، وpackages/contract يطابقه حرفيًا.
- docs/VISION.md: للسياق فقط.
- عند أي تعارض: docs/BUILD_PROMPT.md هو الحاكم.

## الستاك (محسوم)
- Monorepo بـ npm workspaces: apps/core (Node + TypeScript + Fastify)، apps/mobile (Expo + TypeScript عبر Expo Go)، packages/contract.
- SQLite عبر better-sqlite3. الاختبارات Vitest مع FakeModelClient.
- مزود نموذج واحد: Anthropic. ANTHROPIC_API_KEY وMODEL_NAME من env فقط.

## البيئة
- Windows وPowerShell. أي سكربت في package.json لازم يعمل على Windows، بدون الاعتماد على bash أو أوامر Unix.
- الـCore يعمل على كمبيوتر أحمد ويستمع على 0.0.0.0، والجوال على نفس شبكة الواي فاي.

## قواعد العمل
- نفّذ بالتسلسل. لا subagents ولا مهام متوازية.
- اعمل داخل مجلد المشروع فقط. لا تقرأ ولا تعدّل ملفات خارجه، ولا تفتح أو تستورد أي مشروع سابق.
- لا كونكترات ولا MCP في هذا المشروع.
- لا تثبيت عام (npm -g)، ولا أدوات نظام تحتاج صلاحيات مدير. إذا احتاجت حزمة ذلك، اختر بديلًا لا يحتاجه وسجّل القرار.
- لا تغيّر إعدادات git العامة. إذا لم تكن هوية git مضبوطة، اضبطها لهذا المستودع فقط.
- لا push ولا رفع إلى GitHub إلا بطلب صريح من أحمد.
- git commit بعد كل مرحلة.
- قبل أي إضافة اسأل: هل هي لازمة لنجاح الـSlice؟ إذا لا، لا تضفها.
- اتخذ القرارات التقنية الصغيرة بنفسك ولا تتوقف لتسأل. سجّل القرارات المهمة في التقرير.
- لا تعتبر العمل منتهيًا إلا إذا نجحت كل الاختبارات. عند الانتهاء: حدّث قسم "التشغيل والاختبار" أدناه، ثم توقف وقدّم التقرير.

## ثوابت الأمان
- كل ملفات الوكيل داخل WORKSPACE_ROOT (افتراضيًا ./workspace في الـCore). كل مسار يُحل بـ realpath ويجب أن يبقى داخله. ارفض .. والمسارات الخارجية والـsymlinks التي تخرج منه.
- الحاجة للموافقة يحددها Tool Registry في الكود، وليس حكم النموذج.
- أي Write Action لا تُنفذ إلا بموافقة صالحة غير منتهية، مطابقة لـ task_id وaction_id وidempotency_key. صلاحية الموافقة 15 دقيقة.
- لا حذف بأي شكل في v0.1، وmove_file بدون overwrite.
- الحالة محفوظة في SQLite. بعد إعادة تشغيل الـCore، أي مهمة عالقة في EXECUTING تنتقل إلى VERIFYING ويُفحص الواقع على القرص، ولا يُعاد التنفيذ أبدًا.
- Audit Log جدول append-only.
- الأسرار من env فقط. ملفات .env ومجلد workspace وملف قاعدة البيانات لا تدخل git، ويُرفع .env.example فقط.
- كل طلب للـCore يحتاج Authorization: Bearer بقيمة APP_TOKEN. التطبيق لا يحمل إلا EXPO_PUBLIC_APP_TOKEN.

## اللغة
- اكتب رسائلك في الترمنال بالإنجليزية، لأن العربي المخلوط بالإنجليزي يظهر مقلوبًا في هذا الترمنال.
- الكود والتعليقات ورسائل commit بالإنجليزية.
- التقرير النهائي: اكتبه بالعربية في docs/REPORT.md، واعرض ملخصًا قصيرًا بالإنجليزية في الترمنال.

## التشغيل والاختبار
كل الأوامر من جذر المشروع في PowerShell.

- التثبيت (مرة واحدة): `npm install`
- إعداد الـCore: `Copy-Item apps/core/.env.example apps/core/.env` ثم عبّئ:
  - `APP_TOKEN`: سر طويل عشوائي (مثال لتوليده: `[guid]::NewGuid().ToString("N") + [guid]::NewGuid().ToString("N")`)
  - `ANTHROPIC_API_KEY`، `MODEL_NAME` (افتراضيًا `claude-opus-5-5`)
  - اختياري: `HOST` (0.0.0.0)، `PORT` (8787)، `WORKSPACE_ROOT` (./workspace)، `DB_FILE` (./ahmed-core.db) — المسارات نسبية إلى apps/core
- تشغيل الـCore: `npm run core` (يستمع على 0.0.0.0:8787، ويُنشئ apps/core/workspace/inbox وقاعدة البيانات تلقائيًا)
- إعداد التطبيق: `Copy-Item apps/mobile/.env.example apps/mobile/.env` ثم عبّئ:
  - `EXPO_PUBLIC_CORE_URL=http://<IP الكمبيوتر على الواي فاي>:8787` (من `ipconfig`، وليس localhost)
  - `EXPO_PUBLIC_APP_TOKEN` = نفس قيمة `APP_TOKEN`
- تشغيل التطبيق: `npm run mobile` ثم امسح رمز QR بتطبيق Expo Go (الجوال على نفس الشبكة). بعد تعديل .env أعد تشغيل Expo.
- الاختبارات: `npm test` (Vitest مع FakeModelClient، بدون مفتاح أو شبكة)
- فحص الأنواع: `npm run typecheck` (contract + core)، و`npm run typecheck -w @ahmed/mobile`
- تحقق إصلاح 20 أكتوبر 2026: نجح 53 اختبارًا، وفحص الأنواع للـcontract والـCore والتطبيق. التفاصيل في القسم 8 من `docs/REPORT.md`. يوم 21 أكتوبر حذف كومت آلي 30 من هذه الاختبارات وأضاف اختبارًا غير صالح؛ أُعيدت في 22 أكتوبر (54 اختبارًا)، وصار `.github/workflows/ci.yml` يشغّل `npm test` وفحص الأنواع على كل push وpull request.
- عند التحديث لهذا الإصلاح: طلبات النقل القديمة التي لا تحتوي بصمة محتوى لا تُنفذ تلقائيًا ولا تُعلّم كمتحقق منها بعد الاستعادة. أعد إرسال طلب النقل عند الحاجة؛ لا يلزم حذف قاعدة البيانات أو المحادثات.
- أول تشغيل للـCore قد يُظهر نافذة Windows Firewall: اسمح لـNode على الشبكات الخاصة (Private) حتى يصل الجوال.
