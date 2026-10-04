package cn.kaoyan.essay.ui;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.Fragment;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

import cn.kaoyan.essay.MainActivity;
import cn.kaoyan.essay.R;
import cn.kaoyan.essay.core.ComposeStore;
import cn.kaoyan.essay.core.SheetState;
import cn.kaoyan.essay.databinding.FragmentComposeResultBinding;
import cn.kaoyan.essay.net.ApiClient;
import cn.kaoyan.essay.net.ApiError;
import cn.kaoyan.essay.net.Dto;
import cn.kaoyan.essay.net.EeaApi;

/**
 * 成文结果页：概览 / 全文（可切换逐句来源）/ 模板句 / 行文复盘。
 * 数据来自 ComposeStore（写作页流式 done 事件解析后的结果）。
 */
public class ComposeResultFragment extends Fragment {

    private FragmentComposeResultBinding b;
    private Dto.Compose compose;
    private ApiClient.Request reviewReq;
    private ApiClient.Request linkReq;
    private final Set<String> markedIds = new LinkedHashSet<>();

    public ComposeResultFragment() {
        super(R.layout.fragment_compose_result);
    }

    @Nullable
    @Override
    public View onCreateView(@NonNull LayoutInflater inflater, @Nullable ViewGroup container, @Nullable Bundle savedInstanceState) {
        b = FragmentComposeResultBinding.inflate(inflater, container, false);
        return b.getRoot();
    }

    @Override
    public void onViewCreated(@NonNull View view, @Nullable Bundle savedInstanceState) {
        super.onViewCreated(view, savedInstanceState);
        compose = ComposeStore.last;
        if (compose == null) {
            Ui.toast(this, R.string.result_empty);
            MainActivity activity = (MainActivity) getActivity();
            if (activity != null) activity.handleBack();
            return;
        }
        renderSummary();
        renderEssay();
        renderSkeletons();
        b.resultSourceSwitch.setOnCheckedChangeListener((v, checked) -> renderEssay());
        b.resultCopy.setOnClickListener(v -> copyEssay());
        b.resultSheet.setOnClickListener(v -> toSheet());
        b.resultRegen.setOnClickListener(v -> regenerate());
        b.resultReviewGo.setOnClickListener(v -> runReview());
        b.resultMarkAll.setOnClickListener(v -> markAllSkeletons());
        // 先出本地复盘（不花模型调用），需要 AI 补充时再点按钮。
        b.resultReviewBody.setText(R.string.result_reviewing);
        runReview();
    }

    @Override
    public void onDestroyView() {
        super.onDestroyView();
        if (reviewReq != null) reviewReq.cancel();
        if (linkReq != null) linkReq.cancel();
        b = null;
    }

    // ---------- 概览 ----------

    private void renderSummary() {
        b.resultWords.setText(getString(R.string.result_words, compose.words, compose.targetHigh));
        int failed = 0;
        for (Dto.Check check : compose.checks) {
            if (!check.pass) failed++;
        }
        b.resultChecks.setText(failed == 0
                ? getString(R.string.result_checks_ok)
                : getString(R.string.result_checks_warn, failed));
        String engineText = compose.category == null || compose.category.isEmpty()
                ? compose.engine
                : compose.engine + " · " + compose.category;
        b.resultEngine.setText(getString(R.string.result_engine, engineText));
        b.resultCalls.setText(getString(R.string.result_calls, compose.calls, seconds(ComposeStore.lastMs)));
        if (!compose.fallbackBlocks.isEmpty()) {
            b.resultFallback.setText(getString(R.string.result_fallback, compose.fallbackBlocks.size()));
            Ui.show(b.resultFallback, true);
        }
        if (compose.aiErrors > 0) {
            String message = compose.aiErrorMessage == null || compose.aiErrorMessage.isEmpty()
                    ? getString(R.string.result_unknown)
                    : compose.aiErrorMessage;
            b.resultAiError.setText(getString(R.string.result_ai_error, message));
            Ui.show(b.resultAiError, true);
        }
        b.resultIssues.removeAllViews();
        for (Dto.Check check : compose.checks) {
            if (!check.pass) addLine(b.resultIssues, check.name + "：" + check.detail, R.color.danger);
        }
        for (String guard : compose.guards) addLine(b.resultIssues, guard, R.color.warning);
    }

    // ---------- 全文与来源 ----------

    private void renderEssay() {
        boolean showSource = b.resultSourceSwitch.isChecked();
        b.resultEssay.removeAllViews();
        addLine(b.resultEssay, compose.essayTitle == null ? "" : compose.essayTitle, R.color.text_primary, true);
        for (Dto.Paragraph paragraph : compose.paragraphs) {
            addLine(b.resultEssay, getString(R.string.result_paragraph, paragraph.index), R.color.brand_blue, true);
            for (Dto.Sentence sentence : paragraph.sentences) {
                addLine(b.resultEssay, sentence.text, R.color.text_primary);
                if (showSource) {
                    addLine(b.resultEssay, compose.sourceSummary(sentence.source), R.color.text_secondary, false);
                }
            }
        }
    }

    // ---------- 模板句 ----------

    private void renderSkeletons() {
        if (compose.usedSkeletons.isEmpty()) {
            Ui.show(b.resultNoSkeleton, true);
            Ui.show(b.resultMarkAll, false);
            b.resultSkeletons.removeAllViews();
            return;
        }
        Ui.show(b.resultNoSkeleton, false);
        Ui.show(b.resultMarkAll, true);
        b.resultSkeletons.removeAllViews();
        for (Dto.UsedSkeleton skeleton : compose.usedSkeletons) {
            LinearLayout row = new LinearLayout(requireContext());
            row.setOrientation(LinearLayout.VERTICAL);
            int pad = dp(8);
            row.setPadding(pad, pad, pad, pad);
            row.setClickable(true);
            addLine(row, skeleton.en == null ? "" : skeleton.en, R.color.text_primary);
            if (skeleton.zh != null && !skeleton.zh.isEmpty()) addLine(row, skeleton.zh, R.color.text_secondary);
            String tail = getString(R.string.result_skeleton_count, skeleton.count)
                    + (markedIds.contains(skeleton.id) ? " · " + getString(R.string.result_marked) : "");
            addLine(row, tail, R.color.text_secondary);
            row.setOnClickListener(v -> markOne(skeleton.id));
            b.resultSkeletons.addView(row);
        }
    }

    private void markOne(String skeletonId) {
        if (skeletonId == null || skeletonId.isEmpty() || markedIds.contains(skeletonId)) return;
        List<String> ids = new ArrayList<>();
        ids.add(skeletonId);
        markSkeletons(ids);
    }

    private void markAllSkeletons() {
        List<String> ids = new ArrayList<>();
        for (Dto.UsedSkeleton skeleton : compose.usedSkeletons) {
            if (skeleton.id != null && !skeleton.id.isEmpty()) ids.add(skeleton.id);
        }
        if (ids.isEmpty()) {
            Ui.toast(this, R.string.result_no_skeleton);
            return;
        }
        markSkeletons(ids);
    }

    /** 两步走：先按 skeletonId 找回卡片，再批量把状态写成「已掌握」。 */
    private void markSkeletons(List<String> skeletonIds) {
        if (linkReq != null) linkReq.cancel();
        linkReq = EeaApi.linkEssay(skeletonIds, new ApiClient.Callback<Dto.StudyLink>() {
            @Override
            public void onSuccess(Dto.StudyLink link) {
                if (b == null) return;
                if (link.cardIds.isEmpty()) {
                    Ui.toast(ComposeResultFragment.this, getString(R.string.mark_failed, getString(R.string.result_no_skeleton)));
                    return;
                }
                EeaApi.markCards(link.cardIds, "mastered", new ApiClient.Callback<Dto.StudyProgress>() {
                    @Override
                    public void onSuccess(Dto.StudyProgress data) {
                        if (b == null) return;
                        markedIds.addAll(skeletonIds);
                        renderSkeletons();
                        Ui.toast(ComposeResultFragment.this,
                                getString(R.string.result_mark_result, link.matched, link.unmatchedSentences));
                    }

                    @Override
                    public void onFailure(ApiError error) {
                        Ui.toast(ComposeResultFragment.this, getString(R.string.mark_failed, error.getMessage()));
                    }
                });
            }

            @Override
            public void onFailure(ApiError error) {
                Ui.toast(ComposeResultFragment.this, getString(R.string.mark_failed, error.getMessage()));
            }
        });
    }

    // ---------- 行文复盘 ----------

    private void runReview() {
        boolean ai = b.resultReviewAi.isChecked();
        if (reviewReq != null) reviewReq.cancel();
        b.resultReviewGo.setEnabled(false);
        b.resultReviewBody.setText(R.string.result_reviewing);
        reviewReq = EeaApi.analysisEssay(compose.analysisBody(ai), new ApiClient.Callback<Dto.Raw>() {
            @Override
            public void onSuccess(Dto.Raw data) {
                if (b == null) return;
                b.resultReviewGo.setEnabled(true);
                b.resultReviewBody.setText(renderReviewText(data.json));
            }

            @Override
            public void onFailure(ApiError error) {
                if (b == null) return;
                b.resultReviewGo.setEnabled(true);
                b.resultReviewBody.setText(getString(R.string.result_review_failed, error.getMessage()));
            }
        });
    }

    /** 把复盘结果体压成可读文本（字段层级深且会随版本增补，只挑稳定的那几层）。 */
    private String renderReviewText(JSONObject data) {
        StringBuilder sb = new StringBuilder();
        JSONObject track = data.optJSONObject("track");
        if (track != null) append(sb, getString(R.string.review_track, track.optString("label", "")));
        append(sb, getString(R.string.review_words_total, data.optInt("totalWords", compose.words)));
        JSONObject insight = data.optJSONObject("aiInsight");
        if (insight != null) {
            append(sb, insight.optString("summary", ""));
            JSONArray pitfalls = insight.optJSONArray("pitfalls");
            if (pitfalls != null && pitfalls.length() > 0) {
                StringBuilder list = new StringBuilder();
                for (int i = 0; i < pitfalls.length(); i++) {
                    if (i > 0) list.append("；");
                    list.append(pitfalls.optString(i, ""));
                }
                append(sb, getString(R.string.review_pitfalls, list));
            }
        }
        JSONArray paragraphs = data.optJSONArray("paragraphs");
        if (paragraphs != null) {
            for (int i = 0; i < paragraphs.length(); i++) {
                JSONObject paragraph = paragraphs.optJSONObject(i);
                if (paragraph == null) continue;
                append(sb, "— " + paragraph.optString("name", getString(R.string.result_paragraph, i + 1))
                        + " · " + paragraph.optInt("words", 0) + " 词");
                String purpose = paragraph.optString("purpose", "");
                if (!purpose.isEmpty()) append(sb, getString(R.string.review_paragraph_purpose, purpose));
                String aiNote = paragraph.optString("aiNote", "");
                if (!aiNote.isEmpty()) append(sb, getString(R.string.review_ai_title) + "：" + aiNote);
                JSONArray sentences = paragraph.optJSONArray("sentences");
                if (sentences == null) continue;
                for (int j = 0; j < sentences.length(); j++) {
                    JSONObject sentence = sentences.optJSONObject(j);
                    if (sentence == null) continue;
                    String role = sentence.optString("roleLabel", "");
                    String note = sentence.optString("factNote", "");
                    StringBuilder line = new StringBuilder("· ");
                    line.append(role.isEmpty() ? getString(R.string.review_role_unknown) : role);
                    if (!note.isEmpty()) line.append("（").append(note).append("）");
                    append(sb, line.toString());
                }
            }
        }
        return sb.length() == 0 ? getString(R.string.result_no_review) : sb.toString();
    }

    // ---------- 操作 ----------

    private void copyEssay() {
        Context ctx = getContext();
        if (ctx == null) return;
        ClipboardManager cm = (ClipboardManager) ctx.getSystemService(Context.CLIPBOARD_SERVICE);
        if (cm == null) return;
        cm.setPrimaryClip(ClipData.newPlainText(getString(R.string.result_title), SheetState.plainText()));
        Ui.toast(this, R.string.result_copy_done);
    }

    private void toSheet() {
        SheetState.fromCompose(compose);
        MainActivity activity = (MainActivity) getActivity();
        if (activity == null) return;
        Ui.toast(this, R.string.result_to_sheet_done);
        activity.openTab(R.id.nav_sheet);
    }

    private void regenerate() {
        ComposeStore.autoGenerate = true;
        MainActivity activity = (MainActivity) getActivity();
        if (activity == null) return;
        activity.openTab(R.id.nav_write);
    }

    // ---------- 排版小工具 ----------

    private void addLine(LinearLayout parent, String text, int colorRes) {
        addLine(parent, text, colorRes, false);
    }

    private void addLine(LinearLayout parent, String text, int colorRes, boolean bold) {
        if (text == null || text.isEmpty()) return;
        TextView tv = new TextView(parent.getContext());
        tv.setText(text);
        tv.setTextSize(TypedValue.COMPLEX_UNIT_PX, getResources().getDimension(R.dimen.text_body));
        tv.setTextColor(ContextCompat.getColor(parent.getContext(), colorRes));
        tv.setLineSpacing(dp(4), 1f);
        if (bold) tv.setTypeface(null, android.graphics.Typeface.BOLD);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(2);
        lp.bottomMargin = dp(2);
        parent.addView(tv, lp);
    }

    private static void append(StringBuilder sb, String line) {
        if (line == null || line.isEmpty()) return;
        if (sb.length() > 0) sb.append('\n');
        sb.append(line);
    }

    private int dp(int value) {
        return Math.round(getResources().getDisplayMetrics().density * value);
    }

    private static String seconds(long millis) {
        if (millis <= 0) return "-";
        return String.format(java.util.Locale.CHINA, "%.1fs", millis / 1000.0);
    }
}
