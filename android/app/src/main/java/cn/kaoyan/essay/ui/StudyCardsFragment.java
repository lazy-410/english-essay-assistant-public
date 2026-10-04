package cn.kaoyan.essay.ui;

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

import org.json.JSONObject;

import cn.kaoyan.essay.R;
import cn.kaoyan.essay.core.AppState;
import cn.kaoyan.essay.databinding.FragmentStudyCardsBinding;
import cn.kaoyan.essay.net.ApiClient;
import cn.kaoyan.essay.net.ApiError;
import cn.kaoyan.essay.net.Dto;
import cn.kaoyan.essay.net.EeaApi;
import cn.kaoyan.essay.util.Exports;

/**
 * 背诵卡片子页：进度、每日计划、当前单元的卡片（点按标记掌握 / 待复习），可导出卡片 PDF。
 */
public class StudyCardsFragment extends Fragment {

    private FragmentStudyCardsBinding b;
    private ApiClient.Request planReq;
    private ApiClient.Request actionReq;
    private ApiClient.Request pdfReq;
    private Dto.StudyPlan plan;

    public StudyCardsFragment() {
        super(R.layout.fragment_study_cards);
    }

    @Nullable
    @Override
    public View onCreateView(@NonNull LayoutInflater inflater, @Nullable ViewGroup container, @Nullable Bundle savedInstanceState) {
        b = FragmentStudyCardsBinding.inflate(inflater, container, false);
        return b.getRoot();
    }

    @Override
    public void onViewCreated(@NonNull View view, @Nullable Bundle savedInstanceState) {
        super.onViewCreated(view, savedInstanceState);
        b.scPrevUnit.setOnClickListener(v -> changeUnit(-1));
        b.scNextUnit.setOnClickListener(v -> changeUnit(1));
        b.scSavePlan.setOnClickListener(v -> savePlan());
        b.scPrint.setOnClickListener(v -> printCards());
        loadPlan();
    }

    @Override
    public void onDestroyView() {
        super.onDestroyView();
        if (planReq != null) planReq.cancel();
        if (actionReq != null) actionReq.cancel();
        if (pdfReq != null) pdfReq.cancel();
        b = null;
    }

    // ---------- 数据 ----------

    private void loadPlan() {
        if (planReq != null) planReq.cancel();
        planReq = EeaApi.studyPlan(new ApiClient.Callback<Dto.StudyPlan>() {
            @Override
            public void onSuccess(Dto.StudyPlan data) {
                if (b == null) return;
                plan = data;
                render();
            }

            @Override
            public void onFailure(ApiError error) {
                if (b == null) return;
                b.scScope.setText(getString(R.string.sc_failed, error.getMessage()));
            }
        });
    }

    private void render() {
        Dto.StudyPlan p = plan;
        String direction = p.examTypeLabel == null || p.examTypeLabel.isEmpty() ? "" : "（" + p.examTypeLabel + "）";
        b.scTitle.setText(getString(R.string.sc_title, direction, p.percent));
        b.scScope.setText(p.scopeNote == null ? "" : p.scopeNote);
        b.scProgress.setProgressCompat(p.percent, true);
        b.scSummary.setText(getString(R.string.sc_summary, p.mastered, p.review, p.freshCard));
        b.scUnit.setText(getString(R.string.sc_unit, p.currentUnit, Math.max(1, p.totalUnits)));
        b.scDaily.setText(String.valueOf(p.dailyCount));
        b.scOptional.setChecked(p.includeOptional);
        b.scExtended.setChecked(p.includeExtended);
        b.scTodayLabel.setText(getString(R.string.sc_today, p.cards.size()));
        b.scCards.removeAllViews();
        if (p.cards.isEmpty()) {
            addLine(b.scCards, getString(R.string.sc_none), R.color.text_secondary);
            return;
        }
        for (Dto.StudyCard card : p.cards) addCard(card);
    }

    private void addCard(final Dto.StudyCard card) {
        LinearLayout row = new LinearLayout(requireContext());
        row.setOrientation(LinearLayout.VERTICAL);
        row.setPadding(0, dp(8), 0, dp(8));

        addLine(row, card.en, R.color.text_primary, true);
        if (card.zhMissing || card.zh == null || card.zh.isEmpty()) {
            addLine(row, getString(R.string.sc_zh_missing), R.color.text_secondary);
        } else {
            addLine(row, card.zh, R.color.text_secondary);
        }
        String meta = card.moduleLabel + (card.trackLabel.isEmpty() ? "" : " · " + card.trackLabel)
                + " · " + statusLabel(card.status);
        addLine(row, meta, R.color.text_secondary);

        LinearLayout actions = new LinearLayout(requireContext());
        actions.setOrientation(LinearLayout.HORIZONTAL);
        com.google.android.material.button.MaterialButton mastered =
                new com.google.android.material.button.MaterialButton(requireContext(), null,
                        com.google.android.material.R.attr.materialButtonOutlinedStyle);
        mastered.setText(R.string.sc_mark_mastered);
        setSmall(mastered);
        mastered.setOnClickListener(v -> setStatus(card.cardId, "mastered"));
        com.google.android.material.button.MaterialButton review =
                new com.google.android.material.button.MaterialButton(requireContext(), null,
                        com.google.android.material.R.attr.borderlessButtonStyle);
        review.setText(R.string.sc_mark_review);
        setSmall(review);
        review.setOnClickListener(v -> setStatus(card.cardId, "review"));
        actions.addView(mastered);
        actions.addView(review);
        row.addView(actions);
        b.scCards.addView(row);
    }

    private String statusLabel(String status) {
        if ("mastered".equals(status)) return getString(R.string.sc_status_mastered);
        if ("review".equals(status)) return getString(R.string.sc_status_review);
        return getString(R.string.sc_status_new);
    }

    // ---------- 操作 ----------

    private void setStatus(String cardId, String status) {
        if (actionReq != null) actionReq.cancel();
        actionReq = EeaApi.setCardStatus(cardId, status, new ApiClient.Callback<Dto.StudyProgress>() {
            @Override
            public void onSuccess(Dto.StudyProgress data) {
                loadPlan();
            }

            @Override
            public void onFailure(ApiError error) {
                Ui.toast(StudyCardsFragment.this, getString(R.string.sc_failed, error.getMessage()));
            }
        });
    }

    private void savePlan() {
        JSONObject body = new JSONObject();
        try {
            String daily = b.scDaily.getText() == null ? "" : b.scDaily.getText().toString().trim();
            if (!daily.isEmpty()) body.put("dailyCount", Integer.parseInt(daily));
            body.put("includeOptional", b.scOptional.isChecked());
            body.put("includeExtended", b.scExtended.isChecked());
            if (AppState.get().examType() != null && AppState.get().examType().examType != null) {
                body.put("examType", AppState.get().examType().examType);
            }
        } catch (Exception ignored) {
            // 输入非数字时忽略每日数量
        }
        if (actionReq != null) actionReq.cancel();
        actionReq = EeaApi.saveStudyPlan(body, new ApiClient.Callback<Dto.StudyPlan>() {
            @Override
            public void onSuccess(Dto.StudyPlan data) {
                if (b == null) return;
                plan = data;
                render();
                Ui.toast(StudyCardsFragment.this, R.string.sc_plan_saved);
            }

            @Override
            public void onFailure(ApiError error) {
                Ui.toast(StudyCardsFragment.this, getString(R.string.sc_failed, error.getMessage()));
            }
        });
    }

    private void changeUnit(int delta) {
        if (plan == null) return;
        int target = plan.currentUnit + delta;
        if (target < 1 || target > Math.max(1, plan.totalUnits)) return;
        if (actionReq != null) actionReq.cancel();
        actionReq = EeaApi.setStudyUnit(target, new ApiClient.Callback<Dto.Raw>() {
            @Override
            public void onSuccess(Dto.Raw data) {
                loadPlan();
            }

            @Override
            public void onFailure(ApiError error) {
                Ui.toast(StudyCardsFragment.this, getString(R.string.sc_failed, error.getMessage()));
            }
        });
    }

    private void printCards() {
        if (pdfReq != null) pdfReq.cancel();
        JSONObject filter = new JSONObject();
        try {
            if (plan != null && plan.examType != null) filter.put("examType", plan.examType);
        } catch (Exception ignored) {
            // JSONObject.put 不会抛
        }
        Ui.toast(this, R.string.sc_pdf_busy);
        pdfReq = EeaApi.printCards(filter, new ApiClient.Callback<byte[]>() {
            @Override
            public void onSuccess(byte[] data) {
                if (!isAdded() || data == null || data.length == 0) return;
                Exports.shareBytes(requireActivity(), "背诵卡片.pdf", data, "application/pdf");
                Ui.toast(StudyCardsFragment.this, R.string.sc_pdf_ready);
            }

            @Override
            public void onFailure(ApiError error) {
                Ui.toast(StudyCardsFragment.this, getString(R.string.sc_failed, error.getMessage()));
            }
        });
    }

    // ---------- 排版 ----------

    private void setSmall(com.google.android.material.button.MaterialButton button) {
        button.setTextSize(TypedValue.COMPLEX_UNIT_PX, getResources().getDimension(R.dimen.text_label));
        button.setInsetTop(0);
        button.setInsetBottom(0);
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
        tv.setLineSpacing(dp(3), 1f);
        if (bold) tv.setTypeface(null, android.graphics.Typeface.BOLD);
        parent.addView(tv);
    }

    private int dp(int value) {
        return Math.round(getResources().getDisplayMetrics().density * value);
    }
}
