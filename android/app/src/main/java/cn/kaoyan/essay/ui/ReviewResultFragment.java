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

import java.util.List;

import cn.kaoyan.essay.MainActivity;
import cn.kaoyan.essay.R;
import cn.kaoyan.essay.core.ReviewStore;
import cn.kaoyan.essay.core.SheetState;
import cn.kaoyan.essay.databinding.FragmentReviewResultBinding;
import cn.kaoyan.essay.net.ApiClient;
import cn.kaoyan.essay.net.ApiError;
import cn.kaoyan.essay.net.Dto;
import cn.kaoyan.essay.net.EeaApi;
import cn.kaoyan.essay.util.Exports;

/**
 * 批改第三步：估分与得失去分点、分项估分、范文对比、逐条修改项（采纳/忽略）、终稿与导出。
 * 采纳结果实时回传 /api/review/apply 生成终稿。
 */
public class ReviewResultFragment extends Fragment {

    private FragmentReviewResultBinding b;
    private Dto.Review review;
    private ApiClient.Request applyReq;
    private ApiClient.Request pdfReq;

    public ReviewResultFragment() {
        super(R.layout.fragment_review_result);
    }

    @Nullable
    @Override
    public View onCreateView(@NonNull LayoutInflater inflater, @Nullable ViewGroup container, @Nullable Bundle savedInstanceState) {
        b = FragmentReviewResultBinding.inflate(inflater, container, false);
        return b.getRoot();
    }

    @Override
    public void onViewCreated(@NonNull View view, @Nullable Bundle savedInstanceState) {
        super.onViewCreated(view, savedInstanceState);
        review = ReviewStore.review;
        if (review == null) {
            Ui.toast(this, R.string.rr_empty);
            MainActivity activity = (MainActivity) getActivity();
            if (activity != null) activity.handleBack();
            return;
        }
        renderGrade();
        renderScore();
        renderComparison();
        renderIssues();
        b.rrCopy.setOnClickListener(v -> copyFinal());
        b.rrPdf.setOnClickListener(v -> exportPdf());
        b.rrSheet.setOnClickListener(v -> toSheet());
        b.rrAgain.setOnClickListener(v -> {
            ReviewStore.resetResult();
            MainActivity activity = (MainActivity) getActivity();
            if (activity != null) activity.openTab(R.id.nav_review);
        });
        renderFinal();
    }

    @Override
    public void onDestroyView() {
        super.onDestroyView();
        if (applyReq != null) applyReq.cancel();
        if (pdfReq != null) pdfReq.cancel();
        b = null;
    }

    // ---------- 估分 ----------

    private void renderGrade() {
        Dto.Grade grade = review.grade;
        b.rrBand.setText(grade.band == null || grade.band.isEmpty() ? "—" : grade.band);
        String examLabel = review.examLabel == null || review.examLabel.isEmpty() ? "" : review.examLabel + " · ";
        b.rrMeta.setText(examLabel + review.category + " · " + getString(R.string.rv_words, review.words));
        b.rrSummary.setText(grade.summary);
        b.rrCounts.setText(getString(R.string.rr_counts, grade.grammar, grade.required, grade.suggested, grade.structure));
        b.rrGains.setText(getString(R.string.rr_gains, grade.gains.isEmpty() ? getString(R.string.rr_none) : join(grade.gains, "；")));
        b.rrLosses.setText(getString(R.string.rr_losses, grade.losses.isEmpty() ? getString(R.string.rr_none) : join(grade.losses, "；")));
        b.rrDisclaimer.setText(grade.disclaimer);
    }

    private void renderScore() {
        Dto.Score score = review.score;
        if (score == null || score.dimensions.isEmpty()) return;
        b.rrScoreTotal.setText(getString(R.string.rr_score_total, score.totalLow, score.totalHigh, score.full));
        b.rrScoreRows.removeAllViews();
        for (Dto.ScoreDim dim : score.dimensions) {
            addLine(b.rrScoreRows, getString(R.string.rr_dim, dim.label, dim.low, dim.high, dim.max)
                    + (dim.reason == null || dim.reason.isEmpty() ? "" : " · " + dim.reason), R.color.text_secondary);
        }
        Ui.show(b.rrScoreCard, true);
    }

    private void renderComparison() {
        Dto.Comparison comparison = review.comparison;
        if (comparison == null) return;
        Ui.show(b.rrCompareCard, true);
        if (!comparison.available) {
            b.rrCompareBody.setText(comparison.note);
            return;
        }
        StringBuilder sb = new StringBuilder();
        String gap = comparison.wordGap == 0 ? getString(R.string.rr_gap_equal)
                : comparison.wordGap < 0 ? getString(R.string.rr_gap_less, -comparison.wordGap)
                : getString(R.string.rr_gap_more, comparison.wordGap);
        sb.append(getString(R.string.rr_compare_words, comparison.myWords, comparison.modelWords, gap));
        sb.append('\n').append(getString(R.string.rr_compare_paragraphs, comparison.myParagraphs, comparison.modelParagraphs));
        sb.append('\n').append(comparison.missingModules.isEmpty()
                ? getString(R.string.rr_modules_ok)
                : getString(R.string.rr_missing_modules, join(comparison.missingModules, "、")));
        if (!comparison.notableWords.isEmpty()) {
            sb.append('\n').append(getString(R.string.rr_notable_words, join(comparison.notableWords, "、")));
        }
        if (comparison.note != null && !comparison.note.isEmpty()) sb.append('\n').append(comparison.note);
        b.rrCompareBody.setText(sb.toString());
    }

    // ---------- 修改项 ----------

    private void renderIssues() {
        b.rrIssues.removeAllViews();
        addGroup("required");
        addGroup("suggested");
        addGroup("structure");
    }

    private void addGroup(String severity) {
        List<Dto.Issue> items = review.issuesOf(severity);
        if (items.isEmpty()) return;
        com.google.android.material.card.MaterialCardView card = new com.google.android.material.card.MaterialCardView(requireContext());
        card.setCardBackgroundColor(ContextCompat.getColor(requireContext(), R.color.surface));
        card.setStrokeColor(ContextCompat.getColor(requireContext(), R.color.outline));
        card.setStrokeWidth(dp(1));
        card.setRadius(dp(12));
        LinearLayout.LayoutParams cardLp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        cardLp.topMargin = dp(12);
        card.setLayoutParams(cardLp);

        LinearLayout column = new LinearLayout(requireContext());
        column.setOrientation(LinearLayout.VERTICAL);
        column.setPadding(dp(12), dp(12), dp(12), dp(12));

        String label = severityLabel(severity);
        TextView title = new TextView(requireContext());
        title.setText(getString(R.string.rr_group_title, label, items.size()));
        title.setTextSize(TypedValue.COMPLEX_UNIT_PX, getResources().getDimension(R.dimen.text_title));
        title.setTextColor(ContextCompat.getColor(requireContext(), R.color.text_primary));
        column.addView(title);

        for (Dto.Issue issue : items) column.addView(buildIssueRow(issue));
        card.addView(column);
        b.rrIssues.addView(card);
    }

    private View buildIssueRow(final Dto.Issue issue) {
        LinearLayout row = new LinearLayout(requireContext());
        row.setOrientation(LinearLayout.VERTICAL);
        row.setPadding(0, dp(10), 0, dp(4));

        addLine(row, issue.title, R.color.text_primary, true);
        if (!issue.quote.isEmpty()) addLine(row, getString(R.string.rr_quote, issue.quote), R.color.danger);
        String rewrite = issue.rewrite();
        if (rewrite != null && !rewrite.isEmpty()) addLine(row, getString(R.string.rr_fix, rewrite), R.color.success);
        if (!issue.slots.isEmpty()) addLine(row, getString(R.string.rr_slots, join(issue.slots, "、")), R.color.text_secondary);
        if (!issue.detail.isEmpty()) addLine(row, issue.detail, R.color.text_secondary);
        String basis = getString(R.string.rr_basis, issue.basis)
                + (issue.aiWhy != null && !issue.aiWhy.isEmpty() ? getString(R.string.rr_ai_why, issue.aiWhy) : "")
                + (issue.page > 0 ? "｜" + getString(R.string.rr_page, issue.page) : "");
        addLine(row, basis, R.color.text_secondary);

        final TextView status = new TextView(requireContext());
        status.setTextSize(TypedValue.COMPLEX_UNIT_PX, getResources().getDimension(R.dimen.text_label));
        row.addView(status);

        if (!issue.canAccept()) {
            addLine(row, getString(R.string.rr_cannot_auto), R.color.text_secondary);
            updateStatusView(status, issue.id);
            return row;
        }

        LinearLayout actions = new LinearLayout(requireContext());
        actions.setOrientation(LinearLayout.HORIZONTAL);
        com.google.android.material.button.MaterialButton accept = new com.google.android.material.button.MaterialButton(
                requireContext(), null, com.google.android.material.R.attr.materialButtonOutlinedStyle);
        accept.setText(R.string.rr_accept);
        accept.setTextSize(TypedValue.COMPLEX_UNIT_PX, getResources().getDimension(R.dimen.text_label));
        accept.setInsetTop(0);
        accept.setInsetBottom(0);
        accept.setOnClickListener(v -> {
            ReviewStore.accepted.add(issue.id);
            ReviewStore.ignored.remove(issue.id);
            updateStatusView(status, issue.id);
            updateFinal();
        });
        com.google.android.material.button.MaterialButton ignore = new com.google.android.material.button.MaterialButton(
                requireContext(), null, com.google.android.material.R.attr.borderlessButtonStyle);
        ignore.setText(R.string.rr_ignore);
        ignore.setTextSize(TypedValue.COMPLEX_UNIT_PX, getResources().getDimension(R.dimen.text_label));
        ignore.setOnClickListener(v -> {
            ReviewStore.accepted.remove(issue.id);
            ReviewStore.ignored.add(issue.id);
            updateStatusView(status, issue.id);
            updateFinal();
        });
        actions.addView(accept);
        actions.addView(ignore);
        row.addView(actions);
        if (issue.needsFill()) addLine(row, getString(R.string.rr_needs_fill), R.color.warning);
        updateStatusView(status, issue.id);
        return row;
    }

    private void updateStatusView(TextView view, String issueId) {
        boolean accepted = ReviewStore.accepted.contains(issueId);
        boolean touched = accepted || ReviewStore.ignored.contains(issueId);
        view.setText(accepted ? getString(R.string.rr_accepted) : touched ? getString(R.string.rr_ignored) : "");
        view.setTextColor(ContextCompat.getColor(requireContext(), accepted ? R.color.success : R.color.text_secondary));
    }

    // ---------- 终稿 ----------

    /** 采纳集合变化 → 重新生成终稿与 diff。 */
    private void updateFinal() {
        if (ReviewStore.accepted.isEmpty()) {
            ReviewStore.applied = null;
            ReviewStore.finalText = ReviewStore.essayText;
            renderFinal();
            return;
        }
        if (applyReq != null) applyReq.cancel();
        applyReq = EeaApi.reviewApply(ReviewStore.essayText, ReviewStore.issuesArray(),
                new java.util.ArrayList<>(ReviewStore.accepted), new ApiClient.Callback<Dto.ReviewApply>() {
                    @Override
                    public void onSuccess(Dto.ReviewApply data) {
                        if (b == null) return;
                        ReviewStore.applied = data;
                        ReviewStore.finalText = data.text;
                        renderFinal();
                    }

                    @Override
                    public void onFailure(ApiError error) {
                        if (b == null) return;
                        addLine(b.rrDiff, getString(R.string.rr_apply_failed, error.getMessage()), R.color.danger);
                    }
                });
    }

    private void renderFinal() {
        if (b == null) return;
        b.rrAcceptedCount.setText(getString(R.string.rr_accepted) + " " + ReviewStore.accepted.size());
        b.rrDiff.removeAllViews();
        Dto.ReviewApply applied = ReviewStore.applied;
        if (applied != null) {
            for (Dto.ReviewApply.Diff diff : applied.applied) {
                addLine(b.rrDiff, getString(R.string.rr_quote, diff.from), R.color.danger);
                addLine(b.rrDiff, getString(R.string.rr_fix, diff.to), R.color.success);
            }
            if (!applied.manual.isEmpty()) {
                addLine(b.rrDiff, getString(R.string.rr_final_need_manual, applied.manual.size()), R.color.warning);
                for (Dto.ReviewApply.Manual manual : applied.manual) {
                    addLine(b.rrDiff, manual.title, R.color.text_primary);
                    if (manual.template != null && !manual.template.isEmpty()) {
                        addLine(b.rrDiff, getString(R.string.rr_final_template, manual.template), R.color.text_secondary);
                    }
                }
            }
        }
        String body = ReviewStore.body();
        if (body.isEmpty()) {
            addLine(b.rrDiff, getString(R.string.rr_final_none), R.color.text_secondary);
            return;
        }
        if (!ReviewStore.accepted.isEmpty() || applied != null) {
            addLine(b.rrDiff, "—", R.color.outline);
        }
        for (String paragraph : body.split("\n\\s*\n")) {
            if (paragraph.trim().isEmpty()) continue;
            addLine(b.rrDiff, paragraph.trim(), R.color.text_primary);
        }
    }

    // ---------- 操作 ----------

    private void copyFinal() {
        Context ctx = getContext();
        if (ctx == null) return;
        ClipboardManager cm = (ClipboardManager) ctx.getSystemService(Context.CLIPBOARD_SERVICE);
        if (cm == null) return;
        cm.setPrimaryClip(ClipData.newPlainText(getString(R.string.rr_final_title), ReviewStore.body()));
        Ui.toast(this, R.string.rr_copy_done);
    }

    private void exportPdf() {
        if (pdfReq != null) pdfReq.cancel();
        Ui.toast(this, R.string.rr_pdf_busy);
        pdfReq = EeaApi.printReview(review.raw, ReviewStore.body(), new ApiClient.Callback<byte[]>() {
            @Override
            public void onSuccess(byte[] data) {
                if (!isAdded() || data == null || data.length == 0) return;
                String name = "批改报告-" + review.category + ".pdf";
                Exports.shareBytes(requireActivity(), name, data, "application/pdf");
                Ui.toast(ReviewResultFragment.this, R.string.rr_pdf_ready);
            }

            @Override
            public void onFailure(ApiError error) {
                Ui.toast(ReviewResultFragment.this, getString(R.string.rr_pdf_failed, error.getMessage()));
            }
        });
    }

    private void toSheet() {
        String body = ReviewStore.body();
        if (body.isEmpty()) {
            Ui.toast(this, R.string.rv_need_text);
            return;
        }
        SheetState.essayText = body;
        MainActivity activity = (MainActivity) getActivity();
        if (activity == null) return;
        Ui.toast(this, R.string.result_to_sheet_done);
        activity.openTab(R.id.nav_sheet);
    }

    // ---------- 排版小工具 ----------

    private String severityLabel(String severity) {
        if ("required".equals(severity)) return getString(R.string.rr_sev_required);
        if ("suggested".equals(severity)) return getString(R.string.rr_sev_suggested);
        return getString(R.string.rr_sev_structure);
    }

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
        parent.addView(tv, lp);
    }

    private static String join(List<String> values, String sep) {
        StringBuilder sb = new StringBuilder();
        for (String value : values) {
            if (value == null || value.isEmpty()) continue;
            if (sb.length() > 0) sb.append(sep);
            sb.append(value);
        }
        return sb.toString();
    }

    private int dp(int value) {
        return Math.round(getResources().getDisplayMetrics().density * value);
    }
}
