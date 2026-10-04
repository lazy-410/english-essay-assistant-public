package cn.kaoyan.essay.net;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 各接口的返回数据结构（只取界面用得到的字段）。字段名与 server.mjs 一一对应，
 * 避免在界面层散落 optString 字符串。
 */
public final class Dto {

    private Dto() {
    }

    public static final class Health {
        public String status = "";
        public String node = "";
        public String platform = "";
        public boolean hasApiKey;
        public boolean visionReady;
        public boolean knowledgeBuilt;
        public boolean activated;
        public boolean localOcrAvailable;

        static Health parse(JSONObject o) {
            Health h = new Health();
            h.status = o.optString("status", "");
            h.node = o.optString("node", "");
            h.platform = o.optString("platform", "");
            h.hasApiKey = o.optBoolean("hasApiKey", false);
            h.visionReady = o.optBoolean("visionReady", false);
            h.knowledgeBuilt = o.optBoolean("knowledgeBuilt", false);
            h.activated = o.optBoolean("activated", false);
            h.localOcrAvailable = o.optBoolean("localOcrAvailable", false);
            return h;
        }
    }

    public static final class License {
        public boolean activated;
        public boolean permanent;
        public boolean cloud;
        public String expiresAt;
        public String activatedAt;
        public String cloudReason;

        static License parse(JSONObject o) {
            License l = new License();
            l.activated = o.optBoolean("activated", false);
            l.permanent = o.optBoolean("permanent", false);
            l.cloud = "on".equals(o.optString("cloud", "off"));
            l.expiresAt = str(o, "expiresAt");
            l.activatedAt = str(o, "activatedAt");
            l.cloudReason = str(o, "cloudReason");
            return l;
        }
    }

    public static final class Activated {
        public boolean ok;
        public String deviceName;
        public boolean permanent;
        public String expiresAt;

        static Activated parse(JSONObject o) {
            Activated a = new Activated();
            a.ok = o.optBoolean("activated", false);
            a.deviceName = str(o, "deviceName");
            a.permanent = o.optBoolean("permanent", false);
            a.expiresAt = str(o, "expiresAt");
            return a;
        }
    }

    public static final class Config {
        public String deepseekKeyMasked = "";
        public boolean deepseekKeySet;
        public String deepseekBaseUrl = "";
        public String modelReasoning = "";
        public String modelFast = "";
        public String visionKeyMasked = "";
        public boolean visionKeySet;
        public String visionModel = "";
        public boolean visionEnabled = true;
        public String examType;

        static Config parse(JSONObject o) {
            Config c = new Config();
            JSONObject d = o.optJSONObject("deepseek");
            if (d != null) {
                c.deepseekKeyMasked = d.optString("apiKeyMasked", "");
                c.deepseekKeySet = d.optBoolean("hasApiKey", false);
                c.deepseekBaseUrl = d.optString("baseUrl", "");
                c.modelReasoning = d.optString("modelReasoning", "");
                c.modelFast = d.optString("modelFast", "");
            }
            JSONObject v = o.optJSONObject("vision");
            if (v != null) {
                c.visionKeyMasked = v.optString("apiKeyMasked", "");
                c.visionKeySet = v.optBoolean("hasApiKey", false);
                c.visionModel = v.optString("model", "");
                c.visionEnabled = v.optBoolean("enabled", true);
            }
            JSONObject s = o.optJSONObject("study");
            if (s != null) c.examType = str(s, "examType");
            return c;
        }
    }

    public static final class ExamType {
        public String examType;
        public String label;
        public boolean chosen;

        static ExamType parse(JSONObject o) {
            ExamType e = new ExamType();
            e.examType = str(o, "examType");
            e.label = str(o, "label");
            e.chosen = o.optBoolean("chosen", false);
            return e;
        }
    }

    /** 测试连通性（/api/deepseek/test、/api/vision/test）的共用结果。 */
    public static final class TestResult {
        public String model = "";
        public long latencyMs;
        public String note = "";

        public String describe() {
            if (model == null || model.isEmpty()) return note;
            return model + " · " + latencyMs + "ms" + (note.isEmpty() ? "" : " · " + note);
        }
    }

    public static final class WritingStats {
        public int skeletons;
        public int variants;
        public int methods;
        public int examples;

        static WritingStats parse(JSONObject o) {
            WritingStats s = new WritingStats();
            s.skeletons = o.optInt("skeletons", 0);
            s.variants = o.optInt("variants", 0);
            s.methods = o.optInt("methods", 0);
            s.examples = o.optInt("examples", 0);
            return s;
        }
    }

    public static final class KbStats {
        public int exams;
        public int examEssays;
        public int entries;

        static KbStats parse(JSONObject o) {
            KbStats s = new KbStats();
            s.exams = o.optInt("exams", 0);
            s.examEssays = o.optInt("examEssays", 0);
            s.entries = o.optInt("entries", 0);
            return s;
        }
    }

    /** /api/question/clean：OCR 文本清洗。 */
    public static final class Cleaned {
        public String raw = "";
        public String cleaned = "";
        public String model = "";

        static Cleaned parse(JSONObject o) {
            Cleaned c = new Cleaned();
            c.raw = o.optString("raw", "");
            c.cleaned = o.optString("cleaned", "");
            c.model = o.optString("model", "");
            return c;
        }
    }

    /** 图片识别（/api/image/analyze）：题干 + 冲突提示。 */
    public static final class ImageAnalysis {
        public String composedQuestion = "";
        public String ocrText = "";
        public int ocrLines;
        public String visionModel = "";
        public String visionError;
        public String fallback;
        public long latencyMs;
        public final java.util.List<String> conflicts = new java.util.ArrayList<>();
        public JSONObject raw;

        static ImageAnalysis parse(JSONObject o) {
            ImageAnalysis a = new ImageAnalysis();
            a.raw = o;
            a.composedQuestion = o.optString("composedQuestion", "");
            JSONObject vision = o.optJSONObject("vision");
            if (vision != null) a.visionModel = vision.optString("model", "");
            a.visionError = str(o, "visionError");
            a.fallback = str(o, "fallback");
            a.latencyMs = o.optLong("totalLatencyMs", 0);
            JSONObject ocr = o.optJSONObject("ocr");
            if (ocr != null) {
                a.ocrText = ocr.optString("text", "");
                JSONArray lines = ocr.optJSONArray("lines");
                a.ocrLines = lines == null ? 0 : lines.length();
            }
            JSONArray conflicts = o.optJSONArray("conflicts");
            if (conflicts != null) {
                for (int i = 0; i < conflicts.length(); i++) {
                    String line = flatten(conflicts.opt(i));
                    if (!line.isEmpty()) a.conflicts.add(line);
                }
            }
            return a;
        }
    }

    /** 题库列表项（/api/exams）。 */
    public static final class ExamBrief {
        public String id = "";
        public String examType = "";
        public String year = "";
        public String section = "";
        public String essayType = "";
        public String title = "";
        public String prompt = "";
        public String directions = "";
        public String image;
        public boolean hasEssay;

        static ExamBrief parse(JSONObject o) {
            ExamBrief e = new ExamBrief();
            e.id = o.optString("id", "");
            e.examType = o.optString("examType", "");
            e.year = o.optString("year", "");
            e.section = o.optString("section", "");
            e.essayType = o.optString("essayType", "");
            e.title = o.optString("title", "");
            e.prompt = o.optString("prompt", "");
            e.directions = o.optString("directions", "");
            e.image = str(o, "image");
            e.hasEssay = o.optBoolean("hasEssay", false);
            return e;
        }

        public String examLabel() {
            return "e2".equals(examType) ? "英语二" : "英语一";
        }

        public String sectionLabel() {
            if (!"small".equals(section)) return "大作文";
            return "小作文";
        }

        public String typeLabel() {
            if ("chart".equals(essayType)) return "图表";
            if ("picture".equals(essayType)) return "图画";
            if ("hybrid".equals(essayType)) return "图表+图画";
            if ("small".equals(essayType)) return "应用文";
            return essayType == null || essayType.isEmpty() ? "未分类" : essayType;
        }

        /** 列表主标题：年份 + 科目 + 题型。 */
        public String listTitle() {
            return (year == null || year.isEmpty() ? "年份未知" : year + " 年") + " · " + examLabel() + " · " + sectionLabel() + "（" + typeLabel() + "）";
        }

        /** 列表副标题：题干首行。 */
        public String listSubtitle() {
            String body = prompt != null && !prompt.isEmpty() ? prompt : directions;
            if (body == null) return title == null ? "" : title;
            String flat = body.replace('\n', ' ').trim();
            return flat.length() > 60 ? flat.substring(0, 60) + "…" : flat;
        }
    }

    /** 题库详情（/api/exams/detail）。 */
    public static final class ExamDetail {
        public ExamBrief brief = new ExamBrief();
        public String requirements = "";
        public String modelEssayText = "";
        public final java.util.List<String> sources = new java.util.ArrayList<>();
        public JSONObject raw;

        static ExamDetail parse(JSONObject o) {
            ExamDetail d = new ExamDetail();
            d.raw = o;
            d.brief = ExamBrief.parse(o);
            // requirements 是数组（可能为空），拼成多行文本；兼容个别字符串形态。
            JSONArray requirements = o.optJSONArray("requirements");
            if (requirements != null) {
                java.util.List<String> lines = new java.util.ArrayList<>();
                for (int i = 0; i < requirements.length(); i++) {
                    String line = flatten(requirements.opt(i));
                    if (!line.isEmpty()) lines.add(line);
                }
                d.requirements = join(lines, "\n");
            } else {
                d.requirements = o.optString("requirements", "");
            }
            JSONObject model = o.optJSONObject("modelEssay");
            if (model != null) {
                JSONArray paragraphs = model.optJSONArray("paragraphs");
                StringBuilder sb = new StringBuilder();
                if (paragraphs != null) {
                    for (int i = 0; i < paragraphs.length(); i++) {
                        JSONObject p = paragraphs.optJSONObject(i);
                        if (p == null) continue;
                        String text = p.optString("text", "");
                        if (text.isEmpty()) {
                            JSONArray sentences = p.optJSONArray("sentences");
                            if (sentences != null) {
                                for (int j = 0; j < sentences.length(); j++) {
                                    JSONObject s = sentences.optJSONObject(j);
                                    String line = s == null ? sentences.optString(j, "") : s.optString("text", "");
                                    if (!line.isEmpty()) sb.append(line).append(' ');
                                }
                            }
                        } else {
                            sb.append(text).append('\n');
                        }
                        if (i < paragraphs.length() - 1 && sb.length() > 0 && sb.charAt(sb.length() - 1) != '\n') sb.append('\n');
                    }
                }
                d.modelEssayText = sb.toString().trim();
            }
            JSONArray sources = o.optJSONArray("sources");
            if (sources != null) {
                for (int i = 0; i < sources.length(); i++) {
                    String line = flatten(sources.opt(i));
                    if (!line.isEmpty()) d.sources.add(line);
                }
            }
            return d;
        }
    }

    /** 成文结果（/api/compose 与 /api/compose/stream 的 done）。 */
    public static final class Compose {
        public JSONObject raw;
        public String question = "";
        public String engine = "";
        public String category = "";
        public String essayTitle;
        public String salutation;
        public String signature;
        public String date;
        public int words;
        public int targetLow;
        public int targetHigh;
        public boolean allPass;
        public int rounds;
        public int calls;
        public int aiErrors;
        public String aiErrorMessage;
        public final java.util.List<Paragraph> paragraphs = new java.util.ArrayList<>();
        public final java.util.List<Check> checks = new java.util.ArrayList<>();
        public final java.util.List<UsedSkeleton> usedSkeletons = new java.util.ArrayList<>();
        public final java.util.List<String> guards = new java.util.ArrayList<>();
        public final java.util.List<String> fallbackBlocks = new java.util.ArrayList<>();

        static Compose parse(JSONObject o) {
            Compose c = new Compose();
            c.raw = o;
            c.question = o.optString("question", "");
            c.engine = o.optString("engine", "");
            JSONObject classification = o.optJSONObject("classification");
            JSONObject finalCls = classification == null ? null : classification.optJSONObject("final");
            if (finalCls != null) c.category = finalCls.optString("category", "");

            JSONObject essay = o.optJSONObject("essay");
            if (essay != null) {
                c.essayTitle = str(essay, "title");
                c.salutation = str(essay, "salutation");
                c.signature = str(essay, "signature");
                c.date = str(essay, "date");
                JSONArray paragraphs = essay.optJSONArray("paragraphs");
                java.util.Map<String, UsedSkeleton> used = new java.util.LinkedHashMap<>();
                if (paragraphs != null) {
                    for (int i = 0; i < paragraphs.length(); i++) {
                        JSONObject p = paragraphs.optJSONObject(i);
                        if (p == null) continue;
                        Paragraph para = new Paragraph();
                        para.index = i + 1;
                        para.name = p.optString("name", "");
                        JSONArray sentences = p.optJSONArray("sentences");
                        JSONArray sources = p.optJSONArray("sentenceSources");
                        if (sentences != null) {
                            for (int j = 0; j < sentences.length(); j++) {
                                Sentence sentence = new Sentence();
                                sentence.text = sentences.optString(j, "");
                                JSONObject src = sources == null ? null : sources.optJSONObject(j);
                                if (src != null) sentence.source = Source.parse(src);
                                para.sentences.add(sentence);
                                if (sentence.source != null && sentence.source.skeletonId != null
                                        && !sentence.source.skeletonId.isEmpty()) {
                                    UsedSkeleton u = used.get(sentence.source.skeletonId);
                                    if (u == null) {
                                        u = new UsedSkeleton();
                                        u.id = sentence.source.skeletonId;
                                        u.en = sentence.source.skeletonEn;
                                        u.zh = sentence.source.skeletonZh;
                                        used.put(u.id, u);
                                    }
                                    u.count++;
                                }
                            }
                        }
                        c.paragraphs.add(para);
                    }
                }
                c.usedSkeletons.addAll(used.values());
            }

            JSONObject check = o.optJSONObject("check");
            if (check != null) {
                c.words = check.optInt("words", 0);
                c.allPass = check.optBoolean("allPass", false);
                JSONArray target = check.optJSONArray("target");
                if (target != null && target.length() >= 2) {
                    c.targetLow = target.optInt(0, 0);
                    c.targetHigh = target.optInt(1, 0);
                }
                JSONArray checks = check.optJSONArray("checks");
                if (checks != null) {
                    for (int i = 0; i < checks.length(); i++) {
                        JSONObject item = checks.optJSONObject(i);
                        if (item == null) continue;
                        Check row = new Check();
                        row.name = item.optString("name", "");
                        row.pass = item.optBoolean("pass", false);
                        row.detail = item.optString("detail", "");
                        c.checks.add(row);
                    }
                }
                JSONArray fallback = check.optJSONArray("fallbackBlocks");
                if (fallback != null) {
                    for (int i = 0; i < fallback.length(); i++) {
                        String id = fallback.optString(i, "");
                        if (!id.isEmpty()) c.fallbackBlocks.add(id);
                    }
                }
            }

            JSONObject diag = o.optJSONObject("diagnostics");
            if (diag != null) {
                JSONArray roundsArr = diag.optJSONArray("rounds");
                c.rounds = roundsArr == null ? 0 : roundsArr.length();
                c.calls = diag.optInt("calls", 0);
                c.aiErrors = diag.optInt("aiErrors", 0);
                JSONObject aiError = diag.optJSONObject("aiError");
                if (aiError != null) c.aiErrorMessage = str(aiError, "message");
                JSONArray guards = diag.optJSONArray("guards");
                if (guards != null) {
                    for (int i = 0; i < guards.length(); i++) {
                        String g = guards.optString(i, "");
                        if (!g.isEmpty()) c.guards.add(g);
                    }
                }
                JSONArray fb = diag.optJSONArray("fallbackBlocks");
                if (fb != null) {
                    for (int i = 0; i < fb.length(); i++) {
                        String id = fb.optString(i, "");
                        if (!id.isEmpty() && !c.fallbackBlocks.contains(id)) c.fallbackBlocks.add(id);
                    }
                }
            }
            return c;
        }

        /** 供 /api/analysis/essay 复盘的入参（原文 + 分类 + 事实）。 */
        public JSONObject analysisBody(boolean ai) {
            JSONObject body = new JSONObject();
            try {
                if (raw != null) {
                    body.put("essay", raw.optJSONObject("essay"));
                    body.put("classification", raw.optJSONObject("classification"));
                    body.put("facts", raw.optJSONObject("facts"));
                }
                body.put("question", question);
                body.put("ai", ai);
            } catch (Exception ignored) {
                // JSONObject.put 不会抛
            }
            return body;
        }

        /** 逐句来源概览（模板句 + 事实依据），用于结果页来源开关。 */
        public String sourceSummary(Source s) {
            if (s == null) return "无来源信息";
            StringBuilder sb = new StringBuilder();
            sb.append(usageLabel(s.usage));
            if (s.skeletonZh != null && !s.skeletonZh.isEmpty()) sb.append(" · ").append(s.skeletonZh);
            else if (s.rhetoricalFunction != null && !s.rhetoricalFunction.isEmpty()) sb.append(" · ").append(s.rhetoricalFunction);
            if (s.evidence != null && !s.evidence.isEmpty()) sb.append(" · 依据：").append(s.evidence);
            if (s.polished) sb.append(" · 已润色");
            if (s.fallback) sb.append(" · 兜底句");
            return sb.toString();
        }

        private static String usageLabel(String usage) {
            if ("direct".equals(usage)) return "模板直用";
            if ("adapted".equals(usage)) return "模板改写";
            return "自由表达";
        }
    }

    public static final class Paragraph {
        public int index;
        public String name = "";
        public final java.util.List<Sentence> sentences = new java.util.ArrayList<>();
    }

    public static final class Sentence {
        public String text = "";
        public Source source;
    }

    /** 单句来源（essay.paragraphs[].sentenceSources[]）。 */
    public static final class Source {
        public String contentId;
        public String usage = "none";
        public String sourceType;
        public String skeletonId;
        public String skeletonEn;
        public String skeletonZh;
        public String sourceLabel;
        public String rhetoricalFunction;
        public String evidence;
        public boolean polished;
        public boolean fallback;

        static Source parse(JSONObject o) {
            Source s = new Source();
            s.contentId = str(o, "contentId");
            s.usage = o.optString("usage", "none");
            s.polished = o.optBoolean("polished", false);
            s.fallback = o.optBoolean("fallback", false);
            s.skeletonId = str(o, "skeletonId");
            JSONObject skeleton = o.optJSONObject("skeleton");
            if (skeleton != null) {
                s.skeletonEn = str(skeleton, "en");
                s.skeletonZh = str(skeleton, "zh");
                s.rhetoricalFunction = str(skeleton, "rhetoricalFunction");
                JSONObject info = skeleton.optJSONObject("sourceInfo");
                if (info != null) s.sourceLabel = sourceLabel(info);
            }
            JSONObject unit = o.optJSONObject("contentUnit");
            if (unit != null && (s.rhetoricalFunction == null || s.rhetoricalFunction.isEmpty())) {
                s.rhetoricalFunction = str(unit, "rhetoricalFunction");
            }
            JSONObject content = o.optJSONObject("contentSource");
            if (content != null) {
                s.sourceType = str(content, "sourceType");
                JSONArray evidence = content.optJSONArray("evidence");
                if (evidence != null && evidence.length() > 0) {
                    java.util.List<String> parts = new java.util.ArrayList<>();
                    for (int i = 0; i < evidence.length(); i++) {
                        JSONObject e = evidence.optJSONObject(i);
                        String line = e == null ? evidence.optString(i, "") : e.optString("text", e.optString("factId", ""));
                        if (line != null && !line.isEmpty()) parts.add(line);
                    }
                    s.evidence = join(parts, "；");
                }
            }
            return s;
        }

        private static String sourceLabel(JSONObject info) {
            String label = info.optString("label", "");
            String source = info.optString("sourceLabel", "");
            int page = info.optInt("page", 0);
            StringBuilder sb = new StringBuilder();
            if (source != null && !source.isEmpty()) sb.append(source);
            if (label != null && !label.isEmpty()) sb.append(sb.length() > 0 ? " · " : "").append(label);
            if (page > 0) sb.append(sb.length() > 0 ? " · " : "").append("P").append(page);
            return sb.toString();
        }
    }

    /** 本次用到的模板句（按出现次数聚合，用于「标记掌握」）。 */
    public static final class UsedSkeleton {
        public String id = "";
        public String en;
        public String zh;
        public int count;
    }

    public static final class Check {
        public String name = "";
        public boolean pass;
        public String detail = "";
    }

    /** 答题卡渲染结果（/api/handwrite）。 */
    public static final class Handwrite {
        public String svg = "";
        public double width;
        public double height;
        public int usedLines;
        public int placedLines;
        public int availableLines;
        public int overflowLines;
        public String overflowText = "";
        public boolean fits = true;

        static Handwrite parse(JSONObject o) {
            Handwrite h = new Handwrite();
            h.svg = o.optString("svg", "");
            h.width = o.optDouble("width", 0);
            h.height = o.optDouble("height", 0);
            h.usedLines = o.optInt("usedLines", 0);
            h.placedLines = o.optInt("placedLines", 0);
            h.availableLines = o.optInt("availableLines", 0);
            h.overflowLines = o.optInt("overflowLines", 0);
            h.overflowText = o.optString("overflowText", "");
            h.fits = o.optBoolean("fits", true);
            return h;
        }
    }

    public static final class HandTemplate {
        public String key = "";
        public String label = "";
        public String exam = "";
        public String part = "";
        public int lineCount;

        static HandTemplate parse(JSONObject o) {
            HandTemplate t = new HandTemplate();
            t.key = o.optString("key", "");
            t.label = o.optString("label", "");
            t.exam = o.optString("exam", "");
            t.part = o.optString("part", "");
            t.lineCount = o.optInt("lineCount", 0);
            return t;
        }
    }

    public static final class HandFont {
        public String id = "";
        public String label = "";
        public boolean recommended;

        static HandFont parse(JSONObject o) {
            HandFont f = new HandFont();
            f.id = o.optString("id", "");
            f.label = o.optString("label", "");
            f.recommended = o.optBoolean("recommended", false);
            return f;
        }
    }

    /** 学习进度（/api/study/progress、/api/study/link-essay）。 */
    public static final class StudyProgress {
        public int total;
        public int mastered;
        public int review;
        public int freshCard;
        public int percent;
        public int requested;
        public int matched;
        public int unmatchedSentences;

        static StudyProgress parse(JSONObject o) {
            StudyProgress p = new StudyProgress();
            JSONObject summary = o.optJSONObject("summary");
            if (summary != null) {
                p.total = summary.optInt("total", 0);
                p.mastered = summary.optInt("mastered", 0);
                p.review = summary.optInt("review", 0);
                p.freshCard = summary.optInt("new", 0);
                p.percent = summary.optInt("percent", 0);
            }
            p.requested = o.optInt("requested", 0);
            p.matched = o.optInt("matched", 0);
            p.unmatchedSentences = o.optInt("unmatchedSentences", 0);
            return p;
        }
    }

    /** /api/study/link-essay：按 skeletonId 找回的卡片（只取 id，用于后续批量标记）。 */
    public static final class StudyLink {
        public int requested;
        public int matched;
        public int unmatchedSentences;
        public final java.util.List<String> cardIds = new java.util.ArrayList<>();
        /** 卡片 id → 卡片 JSON，B4 学习页直接复用时取字段用。 */
        public final java.util.List<JSONObject> cards = new java.util.ArrayList<>();

        static StudyLink parse(JSONObject o) {
            StudyLink link = new StudyLink();
            link.requested = o.optInt("requested", 0);
            link.matched = o.optInt("matched", 0);
            link.unmatchedSentences = o.optInt("unmatchedSentences", 0);
            JSONArray arr = o.optJSONArray("cards");
            if (arr != null) {
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject card = arr.optJSONObject(i);
                    if (card == null) continue;
                    link.cards.add(card);
                    String id = card.optString("cardId", "");
                    if (!id.isEmpty()) link.cardIds.add(id);
                }
            }
            return link;
        }
    }

    /* ------------------------------ 作文批改 ------------------------------ */

    /** 题型判定（/api/review/classify、review/ocr 的 detection）。 */
    public static final class Detection {
        public String category = "";
        public boolean confident;
        public final java.util.List<String> evidence = new java.util.ArrayList<>();

        static Detection parse(JSONObject o) {
            if (o == null) return null;
            Detection d = new Detection();
            d.category = o.optString("category", "");
            d.confident = o.optBoolean("confident", false);
            JSONArray arr = o.optJSONArray("evidence");
            if (arr != null) {
                for (int i = 0; i < arr.length(); i++) {
                    String line = flatten(arr.opt(i));
                    if (!line.isEmpty()) d.evidence.add(line);
                }
            }
            return d;
        }
    }

    /** 手写作文识别（/api/review/ocr）。 */
    public static final class ReviewOcr {
        public String raw = "";
        public String cleaned = "";
        public String cleanedBy = "none";
        public String channel = "";
        public String channelLabel = "";
        public String backend = "";
        public boolean lowQuality;
        public double latinRatio;
        public String warning = "";
        public String visionError;
        public int unreadableCount;
        public double confidence;
        public double rotationDetected;
        public final java.util.List<String> lines = new java.util.ArrayList<>();
        public Detection detection;

        static ReviewOcr parse(JSONObject o) {
            ReviewOcr r = new ReviewOcr();
            r.raw = o.optString("raw", "");
            r.cleaned = o.optString("cleaned", "");
            r.cleanedBy = o.optString("cleanedBy", "none");
            r.channel = o.optString("channel", "");
            r.channelLabel = o.optString("channelLabel", "");
            r.backend = o.optString("backend", "");
            r.lowQuality = o.optBoolean("lowQuality", false);
            r.latinRatio = o.optDouble("latinRatio", 0);
            r.warning = o.optString("warning", "");
            r.visionError = str(o, "visionError");
            r.unreadableCount = o.optInt("unreadableCount", 0);
            r.confidence = o.optDouble("confidence", 0);
            r.rotationDetected = o.optDouble("rotationDetected", 0);
            JSONArray lines = o.optJSONArray("lines");
            if (lines != null) {
                for (int i = 0; i < lines.length(); i++) {
                    String line = flatten(lines.opt(i));
                    if (!line.isEmpty()) r.lines.add(line);
                }
            }
            r.detection = Detection.parse(o.optJSONObject("detection"));
            return r;
        }
    }

    /** 一条修改项。raw 用于原样回传 /api/review/apply。 */
    public static final class Issue {
        public String id = "";
        public String severity = "";
        public String kind = "";
        public String title = "";
        public String detail = "";
        public String quote = "";
        public String suggestion = "";
        public String replacement;
        public String basis = "";
        public String aiWhy;
        public int page;
        public boolean autoApplicable = true;
        public final java.util.List<String> slots = new java.util.ArrayList<>();
        public JSONObject raw;

        static Issue parse(JSONObject o) {
            Issue i = new Issue();
            i.raw = o;
            i.id = o.optString("id", "");
            i.severity = o.optString("severity", "");
            i.kind = o.optString("kind", "");
            i.title = o.optString("title", "");
            i.detail = o.optString("detail", "");
            i.quote = o.optString("quote", "");
            i.suggestion = o.optString("suggestion", "");
            i.replacement = str(o, "replacement");
            i.basis = o.optString("basis", "");
            i.aiWhy = str(o, "aiWhy");
            i.page = o.optInt("page", 0);
            i.autoApplicable = o.optBoolean("autoApplicable", true);
            JSONArray slots = o.optJSONArray("slots");
            if (slots != null) {
                for (int k = 0; k < slots.length(); k++) {
                    String slot = flatten(slots.opt(k));
                    if (!slot.isEmpty()) i.slots.add(slot);
                }
            }
            return i;
        }

        /** 可自动替换的文本（replacement 优先，其次 suggestion）。 */
        public String rewrite() {
            if (replacement != null && !replacement.isEmpty()) return replacement;
            return suggestion == null || suggestion.isEmpty() ? null : suggestion;
        }

        public boolean canAccept() {
            return !quote.isEmpty() && rewrite() != null;
        }

        /** 含占位符的骨架句不能直接进终稿，需考生自己填空。 */
        public boolean needsFill() {
            return canAccept() && (replacement == null || replacement.isEmpty()) && !autoApplicable;
        }
    }

    /** 分项估分的一个维度。 */
    public static final class ScoreDim {
        public String label = "";
        public String reason = "";
        public int low;
        public int high;
        public int max;

        static ScoreDim parse(JSONObject o) {
            ScoreDim d = new ScoreDim();
            d.label = o.optString("label", "");
            d.reason = o.optString("reason", "");
            d.low = (int) Math.round(o.optDouble("low", 0));
            d.high = (int) Math.round(o.optDouble("high", 0));
            d.max = (int) Math.round(o.optDouble("max", 0));
            return d;
        }
    }

    public static final class Score {
        public final java.util.List<ScoreDim> dimensions = new java.util.ArrayList<>();
        public int totalLow;
        public int totalHigh;
        public int full;

        static Score parse(JSONObject o) {
            if (o == null) return null;
            Score s = new Score();
            JSONArray arr = o.optJSONArray("dimensions");
            if (arr != null) {
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject item = arr.optJSONObject(i);
                    if (item != null) s.dimensions.add(ScoreDim.parse(item));
                }
            }
            s.totalLow = (int) Math.round(o.optDouble("totalLow", 0));
            s.totalHigh = (int) Math.round(o.optDouble("totalHigh", 0));
            s.full = (int) Math.round(o.optDouble("full", 0));
            return s;
        }
    }

    public static final class Grade {
        public String band = "";
        public String summary = "";
        public String disclaimer = "";
        public int grammar;
        public int required;
        public int suggested;
        public int structure;
        public final java.util.List<String> gains = new java.util.ArrayList<>();
        public final java.util.List<String> losses = new java.util.ArrayList<>();

        static Grade parse(JSONObject o) {
            Grade g = new Grade();
            if (o == null) return g;
            g.band = o.optString("band", "");
            g.summary = o.optString("summary", "");
            g.disclaimer = o.optString("disclaimer", "");
            JSONObject counts = o.optJSONObject("counts");
            if (counts != null) {
                g.grammar = counts.optInt("grammar", 0);
                g.required = counts.optInt("required", 0);
                g.suggested = counts.optInt("suggested", 0);
                g.structure = counts.optInt("structure", 0);
            }
            collect(o.optJSONArray("gains"), g.gains);
            collect(o.optJSONArray("losses"), g.losses);
            return g;
        }
    }

    /** 与真题范文的对照（仅真题模式有）。 */
    public static final class Comparison {
        public boolean available;
        public String note = "";
        public int myWords;
        public int modelWords;
        public int wordGap;
        public int myParagraphs;
        public int modelParagraphs;
        public final java.util.List<String> missingModules = new java.util.ArrayList<>();
        public final java.util.List<String> notableWords = new java.util.ArrayList<>();

        static Comparison parse(JSONObject o) {
            if (o == null) return null;
            Comparison c = new Comparison();
            c.available = o.optBoolean("available", false);
            c.note = o.optString("note", "");
            c.myWords = o.optInt("myWords", 0);
            c.modelWords = o.optInt("modelWords", 0);
            c.wordGap = o.optInt("wordGap", 0);
            c.myParagraphs = o.optInt("myParagraphs", 0);
            c.modelParagraphs = o.optInt("modelParagraphs", 0);
            collect(o.optJSONArray("missingModules"), c.missingModules);
            collect(o.optJSONArray("notableWords"), c.notableWords);
            return c;
        }
    }

    /** 批改结果（/api/review/analyze）。 */
    public static final class Review {
        public String category = "";
        public String detectedCategory = "";
        public String trackLabel = "";
        public int words;
        public String examId;
        public String examLabel;
        public Grade grade = new Grade();
        public Score score;
        public Comparison comparison;
        public final java.util.List<Issue> issues = new java.util.ArrayList<>();
        public JSONObject raw;

        static Review parse(JSONObject o) {
            Review r = new Review();
            r.raw = o;
            r.category = o.optString("category", "");
            r.detectedCategory = o.optString("detectedCategory", "");
            r.words = o.optInt("words", 0);
            JSONObject track = o.optJSONObject("track");
            if (track != null) r.trackLabel = track.optString("label", "");
            JSONObject exam = o.optJSONObject("exam");
            if (exam != null) {
                r.examId = str(exam, "id");
                r.examLabel = str(exam, "label");
            }
            r.grade = Grade.parse(o.optJSONObject("grade"));
            r.score = Score.parse(o.optJSONObject("score"));
            r.comparison = Comparison.parse(o.optJSONObject("modelComparison"));
            JSONArray issues = o.optJSONArray("issues");
            if (issues != null) {
                for (int i = 0; i < issues.length(); i++) {
                    JSONObject item = issues.optJSONObject(i);
                    if (item != null) r.issues.add(Issue.parse(item));
                }
            }
            return r;
        }

        public java.util.List<Issue> issuesOf(String severity) {
            java.util.List<Issue> out = new java.util.ArrayList<>();
            for (Issue issue : issues) {
                if (severity.equals(issue.severity)) out.add(issue);
            }
            return out;
        }
    }

    /** 采纳修改项后的终稿（/api/review/apply）。 */
    public static final class ReviewApply {
        public String text = "";
        public final java.util.List<Diff> applied = new java.util.ArrayList<>();
        public final java.util.List<Manual> manual = new java.util.ArrayList<>();

        public static final class Diff {
            public String from = "";
            public String to = "";
        }

        public static final class Manual {
            public String title = "";
            public String template;
        }

        static ReviewApply parse(JSONObject o) {
            ReviewApply r = new ReviewApply();
            r.text = o.optString("text", "");
            JSONArray applied = o.optJSONArray("applied");
            if (applied != null) {
                for (int i = 0; i < applied.length(); i++) {
                    JSONObject item = applied.optJSONObject(i);
                    if (item == null) continue;
                    Diff diff = new Diff();
                    diff.from = item.optString("from", "");
                    diff.to = item.optString("to", "");
                    r.applied.add(diff);
                }
            }
            JSONArray manual = o.optJSONArray("manual");
            if (manual != null) {
                for (int i = 0; i < manual.length(); i++) {
                    JSONObject item = manual.optJSONObject(i);
                    if (item == null) continue;
                    Manual row = new Manual();
                    row.title = item.optString("title", "");
                    row.template = str(item, "template");
                    r.manual.add(row);
                }
            }
            return r;
        }
    }

    private static void collect(JSONArray array, java.util.List<String> out) {
        if (array == null) return;
        for (int i = 0; i < array.length(); i++) {
            String line = flatten(array.opt(i));
            if (!line.isEmpty()) out.add(line);
        }
    }

    /* ------------------------------ 学习（卡片 / 字典 / 计划） ------------------------------ */

    /** 背卡一张（/api/study/plan 的 todayCards、/api/study/cards 的 cards）。 */
    public static final class StudyCard {
        public String cardId = "";
        public String skeletonId = "";
        public String track = "";
        public String trackLabel = "";
        public String moduleLabel = "";
        public String rhetoricalFunction = "";
        public String en = "";
        public String zh = "";
        public boolean zhMissing;
        public int estimatedWords;
        public int unitIndex;
        public String status = "new";
        public String scopeLabel = "";
        public JSONObject raw;

        static StudyCard parse(JSONObject o) {
            StudyCard c = new StudyCard();
            c.raw = o;
            c.cardId = o.optString("cardId", "");
            c.skeletonId = o.optString("skeletonId", "");
            c.track = o.optString("track", "");
            c.trackLabel = o.optString("trackLabel", c.track);
            c.moduleLabel = o.optString("moduleLabel", "");
            c.rhetoricalFunction = o.optString("rhetoricalFunction", "");
            c.en = o.optString("en", "");
            c.zh = o.optString("zh", "");
            c.zhMissing = o.optBoolean("zhMissing", false);
            c.estimatedWords = o.optInt("estimatedWords", 0);
            c.unitIndex = o.optInt("unitIndex", 0);
            c.status = o.optString("status", "new");
            c.scopeLabel = o.optString("scopeLabel", "");
            return c;
        }
    }

    /** 一个学习单元（进度用）。 */
    public static final class StudyUnit {
        public int unitIndex;
        public int total;
        public int mastered;
        public int review;

        static StudyUnit parse(JSONObject o) {
            StudyUnit u = new StudyUnit();
            u.unitIndex = o.optInt("unitIndex", 0);
            JSONArray ids = o.optJSONArray("cardIds");
            u.total = ids == null ? o.optInt("total", 0) : ids.length();
            u.mastered = o.optInt("mastered", 0);
            u.review = o.optInt("review", 0);
            return u;
        }
    }

    /** 学习计划与进度（/api/study/plan、/api/study/cards）。 */
    public static final class StudyPlan {
        public String examType;
        public String examTypeLabel;
        public String scopeNote;
        public int total;
        public int mastered;
        public int review;
        public int freshCard;
        public int percent;
        public int currentUnit;
        public int totalUnits;
        public int totalCards;
        public int dailyCount;
        public boolean includeOptional = true;
        public boolean includeExtended;
        public final java.util.List<String> tracks = new java.util.ArrayList<>();
        public final java.util.List<StudyUnit> units = new java.util.ArrayList<>();
        public final java.util.List<StudyCard> cards = new java.util.ArrayList<>();

        static StudyPlan parse(JSONObject o) {
            StudyPlan p = new StudyPlan();
            p.examType = str(o, "examType");
            p.examTypeLabel = str(o, "examTypeLabel");
            p.scopeNote = str(o, "scopeNote");
            p.currentUnit = o.optInt("currentUnit", 1);
            p.totalUnits = o.optInt("totalUnits", 0);
            p.totalCards = o.optInt("totalCards", 0);
            JSONObject summary = o.optJSONObject("summary");
            if (summary != null) {
                p.total = summary.optInt("total", 0);
                p.mastered = summary.optInt("mastered", 0);
                p.review = summary.optInt("review", 0);
                p.freshCard = summary.optInt("new", 0);
                p.percent = summary.optInt("percent", 0);
            }
            JSONObject options = o.optJSONObject("options");
            if (options != null) {
                p.dailyCount = options.optInt("dailyCount", 0);
                p.includeOptional = options.optBoolean("includeOptional", true);
                p.includeExtended = options.optBoolean("includeExtended", false);
                JSONArray tracks = options.optJSONArray("tracks");
                if (tracks != null) {
                    for (int i = 0; i < tracks.length(); i++) {
                        String track = flatten(tracks.opt(i));
                        if (!track.isEmpty()) p.tracks.add(track);
                    }
                }
            }
            JSONArray units = o.optJSONArray("units");
            if (units != null) {
                for (int i = 0; i < units.length(); i++) {
                    JSONObject unit = units.optJSONObject(i);
                    if (unit != null) p.units.add(StudyUnit.parse(unit));
                }
            }
            JSONArray cards = o.optJSONArray("todayCards");
            if (cards == null) cards = o.optJSONArray("cards");
            if (cards != null) {
                for (int i = 0; i < cards.length(); i++) {
                    JSONObject card = cards.optJSONObject(i);
                    if (card != null) p.cards.add(StudyCard.parse(card));
                }
            }
            return p;
        }
    }

    /** 讲义词表条目（/api/kb/vocab）。 */
    public static final class VocabItem {
        public String en = "";
        public String zh = "";
        public int page;

        static VocabItem parse(JSONObject o) {
            VocabItem v = new VocabItem();
            v.en = o.optString("en", "");
            v.zh = o.optString("zh", "");
            v.page = o.optInt("page", 0);
            return v;
        }
    }

    public static final class VocabPage {
        public int count;
        public final java.util.List<VocabItem> items = new java.util.ArrayList<>();

        static VocabPage parse(JSONObject o) {
            VocabPage p = new VocabPage();
            p.count = o.optInt("count", 0);
            JSONArray arr = o.optJSONArray("vocab");
            if (arr != null) {
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject item = arr.optJSONObject(i);
                    if (item != null) p.items.add(VocabItem.parse(item));
                }
            }
            return p;
        }
    }

    /** 讲义词条（模板句，/api/kb/templates、/api/kb/modules 内嵌）。 */
    public static final class KbTemplate {
        public String id = "";
        public String kind = "";
        public String en = "";
        public String zh = "";
        public String moduleLabel = "";
        public int page;

        static KbTemplate parse(JSONObject o) {
            KbTemplate t = new KbTemplate();
            t.id = o.optString("id", "");
            t.kind = o.optString("kind", "");
            t.en = o.optString("en", "");
            t.zh = o.optString("zh", "");
            t.page = o.optInt("page", 0);
            JSONObject module = o.optJSONObject("module");
            if (module != null) t.moduleLabel = module.optString("label", "");
            return t;
        }
    }

    /** 讲义的写作模块（含该模块下的模板句）。 */
    public static final class KbModule {
        public String id = "";
        public String label = "";
        public String description = "";
        public int count;
        public final java.util.List<KbTemplate> templates = new java.util.ArrayList<>();

        static KbModule parse(JSONObject o) {
            KbModule m = new KbModule();
            m.id = o.optString("id", "");
            m.label = o.optString("label", "");
            m.description = o.optString("description", "");
            m.count = o.optInt("count", 0);
            JSONArray arr = o.optJSONArray("templates");
            if (arr != null) {
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject item = arr.optJSONObject(i);
                    if (item != null) m.templates.add(KbTemplate.parse(item));
                }
            }
            return m;
        }
    }

    /** 写作轨道（/api/kb/modules）。 */
    public static final class KbTrack {
        public String id = "";
        public String label = "";
        public String description = "";
        public int count;
        public final java.util.List<KbModule> modules = new java.util.ArrayList<>();

        static KbTrack parse(JSONObject o) {
            KbTrack t = new KbTrack();
            t.id = o.optString("id", "");
            t.label = o.optString("label", "");
            t.description = o.optString("description", "");
            t.count = o.optInt("count", 0);
            JSONArray arr = o.optJSONArray("modules");
            if (arr != null) {
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject item = arr.optJSONObject(i);
                    if (item != null) t.modules.add(KbModule.parse(item));
                }
            }
            return t;
        }
    }

    /** /api/kb/modules 的返回：tracks 是轨道摘要，track 是选中轨道的明细。 */
    public static final class KbTrackPage {
        public final java.util.List<KbTrack> tracks = new java.util.ArrayList<>();
        public KbTrack track;

        static KbTrackPage parse(JSONObject o) {
            KbTrackPage page = new KbTrackPage();
            JSONArray arr = o.optJSONArray("tracks");
            if (arr != null) {
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject item = arr.optJSONObject(i);
                    if (item != null) page.tracks.add(KbTrack.parse(item));
                }
            }
            JSONObject track = o.optJSONObject("track");
            page.track = track == null ? null : KbTrack.parse(track);
            return page;
        }
    }

    /** 原样保留的结构（行文复盘等只做展示、字段层级较深的接口）。 */
    public static final class Raw {
        public JSONObject json = new JSONObject();

        static Raw parse(JSONObject o) {
            Raw r = new Raw();
            r.json = o;
            return r;
        }
    }

    /** 题库统计（/api/exams/stats）。 */
    public static final class ExamStats {
        public int exams;
        public int withEssay;
        public int withoutEssay;
        public final java.util.Map<String, Integer> examTypes = new java.util.LinkedHashMap<>();
        public final java.util.Map<String, Integer> years = new java.util.LinkedHashMap<>();
        public final java.util.Map<String, Integer> sections = new java.util.LinkedHashMap<>();
        public final java.util.Map<String, Integer> essayTypes = new java.util.LinkedHashMap<>();

        static ExamStats parse(JSONObject o) {
            ExamStats s = new ExamStats();
            s.exams = o.optInt("exams", 0);
            s.withEssay = o.optInt("withEssay", 0);
            s.withoutEssay = o.optInt("withoutEssay", 0);
            counts(o.optJSONObject("examTypes"), s.examTypes);
            counts(o.optJSONObject("years"), s.years);
            counts(o.optJSONObject("sections"), s.sections);
            counts(o.optJSONObject("essayTypes"), s.essayTypes);
            return s;
        }

        private static void counts(JSONObject source, java.util.Map<String, Integer> target) {
            if (source == null) return;
            java.util.Iterator<String> keys = source.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                target.put(key, source.optInt(key, 0));
            }
        }
    }

    /** 题库列表（/api/exams）。 */
    public static final class ExamPage {
        public int count;
        public final java.util.List<ExamBrief> items = new java.util.ArrayList<>();

        static ExamPage parse(JSONObject o) {
            ExamPage page = new ExamPage();
            page.count = o.optInt("count", 0);
            JSONArray arr = o.optJSONArray("exams");
            if (arr != null) {
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject item = arr.optJSONObject(i);
                    if (item != null) page.items.add(ExamBrief.parse(item));
                }
            }
            return page;
        }
    }

    /** 答题卡模板列表（/api/handwrite/templates）。 */
    public static final class HandTemplates {
        public final java.util.List<HandTemplate> items = new java.util.ArrayList<>();

        static HandTemplates parse(JSONObject o) {
            HandTemplates list = new HandTemplates();
            JSONArray arr = o.optJSONArray("templates");
            if (arr != null) {
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject item = arr.optJSONObject(i);
                    if (item != null) list.items.add(HandTemplate.parse(item));
                }
            }
            return list;
        }
    }

    /** 手写字体列表（/api/handwrite/fonts）。 */
    public static final class HandFonts {
        public final java.util.List<HandFont> items = new java.util.ArrayList<>();

        static HandFonts parse(JSONObject o) {
            HandFonts list = new HandFonts();
            JSONArray arr = o.optJSONArray("fonts");
            if (arr != null) {
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject item = arr.optJSONObject(i);
                    if (item != null) list.items.add(HandFont.parse(item));
                }
            }
            return list;
        }
    }

    private static String str(JSONObject o, String key) {
        return o.isNull(key) ? null : o.optString(key, null);
    }

    /** minSdk 24 没有 String.join，这里手写一个。 */
    private static String join(java.util.List<String> parts, String sep) {
        StringBuilder sb = new StringBuilder();
        for (String part : parts) {
            if (part == null || part.isEmpty()) continue;
            if (sb.length() > 0) sb.append(sep);
            sb.append(part);
        }
        return sb.toString();
    }

    /** 把任意 JSON 值压成一行可读文本（冲突项、来源项等结构不固定时使用）。 */
    static String flatten(Object value) {
        if (value == null || value == JSONObject.NULL) return "";
        if (value instanceof JSONArray) {
            JSONArray arr = (JSONArray) value;
            java.util.List<String> parts = new java.util.ArrayList<>();
            for (int i = 0; i < arr.length(); i++) {
                String part = flatten(arr.opt(i));
                if (!part.isEmpty()) parts.add(part);
            }
            return join(parts, "、");
        }
        if (value instanceof JSONObject) {
            JSONObject obj = (JSONObject) value;
            java.util.List<String> parts = new java.util.ArrayList<>();
            java.util.Iterator<String> it = obj.keys();
            while (it.hasNext()) {
                String key = it.next();
                String part = flatten(obj.opt(key));
                if (!part.isEmpty()) parts.add(RESOURCE_LABELS.containsKey(key) ? part : key + "：" + part);
            }
            return join(parts, "；");
        }
        String text = String.valueOf(value);
        return "null".equals(text) ? "" : text.trim();
    }

    /** 冲突项字段名的中文提示（未知字段直接显示原名）。 */
    private static final java.util.Map<String, String> RESOURCE_LABELS = new java.util.HashMap<>();

    static {
        RESOURCE_LABELS.put("questionText", "题干");
        RESOURCE_LABELS.put("prompt", "题干");
        RESOURCE_LABELS.put("model", "模型");
        RESOURCE_LABELS.put("vision", "视觉识别");
        RESOURCE_LABELS.put("ocr", "本地 OCR");
        RESOURCE_LABELS.put("label", "名称");
        RESOURCE_LABELS.put("title", "标题");
        RESOURCE_LABELS.put("text", "内容");
        RESOURCE_LABELS.put("name", "名称");
        RESOURCE_LABELS.put("page", "页码");
    }
}
