package cn.kaoyan.essay.core;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

import cn.kaoyan.essay.net.Dto;

/**
 * 答题卡页的跨页面状态：写作结果「送答题卡」写入这里，答题卡页读取并渲染。
 * 只保存可序列化的设置与作文内容，不持有界面对象。
 * 取值域与桌面端 collectHandRequest() 保持一致：字号 12-28、倾斜 0-15、基线 -4..4。
 */
public final class SheetState {

    private SheetState() {
    }

    public static final String DEFAULT_TEMPLATE = "english1_b";
    public static final int FONT_SIZE_MIN = 12;
    public static final int FONT_SIZE_MAX = 28;
    public static final int FONT_SIZE_DEFAULT = 17;
    public static final int SLANT_MAX = 15;
    public static final int BASELINE_LIMIT = 4;
    /** /api/handwrite 的 essay.paragraphs 用空行分段。 */
    private static final String PARAGRAPH_SPLIT = "\\n\\s*\\n";

    public static String template = DEFAULT_TEMPLATE;
    public static String fontId = "";
    public static int fontSize = FONT_SIZE_DEFAULT;
    public static int slant = 0;
    public static int baselineAdjust = 0;
    public static String color = "black";
    public static String style = "block";
    public static String kind = "letter";

    public static String salutation = "";
    public static String signature = "";
    public static String title = "";
    public static String date = "";
    public static String essayText = "";

    public static boolean hasEssay() {
        return essayText != null && !essayText.trim().isEmpty();
    }

    /** 成文结果带入：段落按句子拼回纯文本，落款用「/」分隔两行（与桌面端一致）。 */
    public static void fromCompose(Dto.Compose compose) {
        if (compose == null) return;
        StringBuilder sb = new StringBuilder();
        for (Dto.Paragraph paragraph : compose.paragraphs) {
            List<String> sentences = new ArrayList<>();
            for (Dto.Sentence sentence : paragraph.sentences) {
                if (sentence.text != null && !sentence.text.trim().isEmpty()) sentences.add(sentence.text.trim());
            }
            if (sentences.isEmpty()) continue;
            if (sb.length() > 0) sb.append("\n\n");
            sb.append(join(sentences, " "));
        }
        essayText = sb.toString();
        salutation = nullToEmpty(compose.salutation);
        signature = nullToEmpty(compose.signature).replace("\n", " / ");
        title = compose.essayTitle == null || compose.essayTitle.trim().isEmpty() ? "" : compose.essayTitle.trim();
        date = nullToEmpty(compose.date);
    }

    /** 组装 /api/handwrite 与 /api/handwrite/pdf 的请求体。 */
    public static JSONObject payload() {
        JSONObject body = new JSONObject();
        JSONObject essay = new JSONObject();
        try {
            JSONArray paragraphs = new JSONArray();
            for (String paragraph : splitParagraphs(essayText)) paragraphs.put(paragraph);
            essay.put("paragraphs", paragraphs);
            if (!salutation.trim().isEmpty()) essay.put("salutation", salutation.trim());
            if (!signature.trim().isEmpty()) {
                essay.put("signature", join(splitSlash(signature), "\n"));
            }
            if (!title.trim().isEmpty()) essay.put("title", title.trim());
            if (!date.trim().isEmpty()) essay.put("date", date.trim());

            body.put("essay", essay);
            if (template != null && !template.trim().isEmpty()) body.put("template", template.trim());
            if (fontId != null && !fontId.trim().isEmpty()) body.put("fontId", fontId.trim());
            body.put("fontSize", clamp(fontSize, FONT_SIZE_MIN, FONT_SIZE_MAX, FONT_SIZE_DEFAULT));
            body.put("slant", clamp(slant, 0, SLANT_MAX, 0));
            body.put("baselineAdjust", clamp(baselineAdjust, -BASELINE_LIMIT, BASELINE_LIMIT, 0));
            body.put("color", color);
            body.put("style", style);
            body.put("kind", kind);
        } catch (Exception ignored) {
            // org.json 只在极端输入下抛错；出现时保持空请求体由服务端报错
        }
        return body;
    }

    /** 纯文本（复制用）。 */
    public static String plainText() {
        StringBuilder sb = new StringBuilder();
        if ("notice".equals(kind) && !title.trim().isEmpty()) sb.append(title.trim()).append("\n\n");
        if ("letter".equals(kind) && !salutation.trim().isEmpty()) sb.append(salutation.trim()).append("\n\n");
        sb.append(essayText == null ? "" : essayText.trim());
        if (!signature.trim().isEmpty()) sb.append("\n\n").append(join(splitSlash(signature), "\n"));
        if (!date.trim().isEmpty()) sb.append("\n").append(date.trim());
        return sb.toString();
    }

    /** 预设：模拟考场（黑色、齐头、微斜）。 */
    public static void presetExam() {
        color = "black";
        style = "block";
        slant = 8;
        baselineAdjust = 0;
        fontSize = FONT_SIZE_DEFAULT;
    }

    /** 预设：红字字帖（红色大字、缩进、无倾斜，便于临摹）。 */
    public static void presetCopybook() {
        color = "red";
        style = "indent";
        slant = 0;
        baselineAdjust = 0;
        fontSize = 22;
    }

    private static List<String> splitParagraphs(String text) {
        List<String> out = new ArrayList<>();
        String value = text == null ? "" : text;
        for (String piece : value.split(PARAGRAPH_SPLIT)) {
            String trimmed = piece.trim();
            if (!trimmed.isEmpty()) out.add(trimmed.replaceAll("\\s*\\n\\s*", " "));
        }
        if (out.isEmpty() && !value.trim().isEmpty()) out.add(value.trim().replaceAll("\\s*\\n\\s*", " "));
        return out;
    }

    private static List<String> splitSlash(String value) {
        String[] parts = value.trim().split("\\s*/\\s*");
        List<String> lines = new ArrayList<>();
        for (String part : parts) {
            if (!part.trim().isEmpty()) lines.add(part.trim());
        }
        return lines;
    }

    private static int clamp(int value, int min, int max, int fallback) {
        if (value < min || value > max) return fallback;
        return value;
    }

    private static String nullToEmpty(String value) {
        return value == null ? "" : value;
    }

    private static String join(List<String> list, String sep) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < list.size(); i++) {
            if (i > 0) sb.append(sep);
            sb.append(list.get(i));
        }
        return sb.toString();
    }
}
