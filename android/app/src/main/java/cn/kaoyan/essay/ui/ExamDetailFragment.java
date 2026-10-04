package cn.kaoyan.essay.ui;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Bundle;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.Fragment;

import cn.kaoyan.essay.MainActivity;
import cn.kaoyan.essay.R;
import cn.kaoyan.essay.core.ComposeStore;
import cn.kaoyan.essay.core.ReviewStore;
import cn.kaoyan.essay.databinding.FragmentExamDetailBinding;
import cn.kaoyan.essay.net.ApiClient;
import cn.kaoyan.essay.net.ApiError;
import cn.kaoyan.essay.net.Dto;
import cn.kaoyan.essay.net.EeaApi;
import cn.kaoyan.essay.util.Exports;

/**
 * 真题详情：题图、题目要求、范文（默认折叠）、出处，以及「带入写作 / 带入批改 / 导出精讲」。
 */
public class ExamDetailFragment extends Fragment {

    private static final String ARG_ID = "examId";

    private FragmentExamDetailBinding b;
    private ApiClient.Request detailReq;
    private ApiClient.Request imageReq;
    private ApiClient.Request pdfReq;
    private Dto.ExamDetail detail;
    private boolean modelShown;

    public static ExamDetailFragment newInstance(String examId) {
        ExamDetailFragment fragment = new ExamDetailFragment();
        Bundle args = new Bundle();
        args.putString(ARG_ID, examId);
        fragment.setArguments(args);
        return fragment;
    }

    public ExamDetailFragment() {
        super(R.layout.fragment_exam_detail);
    }

    @Nullable
    @Override
    public View onCreateView(@NonNull LayoutInflater inflater, @Nullable ViewGroup container, @Nullable Bundle savedInstanceState) {
        b = FragmentExamDetailBinding.inflate(inflater, container, false);
        return b.getRoot();
    }

    @Override
    public void onViewCreated(@NonNull View view, @Nullable Bundle savedInstanceState) {
        super.onViewCreated(view, savedInstanceState);
        String id = getArguments() == null ? "" : getArguments().getString(ARG_ID, "");
        b.edModelToggle.setOnClickListener(v -> {
            modelShown = !modelShown;
            Ui.show(b.edModel, modelShown);
            b.edModelToggle.setText(modelShown ? R.string.ex_detail_model_hide : R.string.ex_detail_model_show);
        });
        b.edCopy.setOnClickListener(v -> copyQuestion());
        b.edPractice.setOnClickListener(v -> practice());
        b.edReview.setOnClickListener(v -> reviewWithExam());
        b.edPdf.setOnClickListener(v -> exportAnalysis());
        if (id.isEmpty()) {
            Ui.toast(this, R.string.rv_pick_empty);
            return;
        }
        load(id);
    }

    @Override
    public void onDestroyView() {
        super.onDestroyView();
        if (detailReq != null) detailReq.cancel();
        if (imageReq != null) imageReq.cancel();
        if (pdfReq != null) pdfReq.cancel();
        b = null;
    }

    private void load(String id) {
        detailReq = EeaApi.examDetail(id, new ApiClient.Callback<Dto.ExamDetail>() {
            @Override
            public void onSuccess(Dto.ExamDetail data) {
                if (b == null) return;
                detail = data;
                render(data);
            }

            @Override
            public void onFailure(ApiError error) {
                if (b == null) return;
                Ui.toast(ExamDetailFragment.this, getString(R.string.ex_detail_failed, error.getMessage()));
            }
        });
    }

    private void render(Dto.ExamDetail data) {
        Dto.ExamBrief brief = data.brief;
        b.edTitle.setText(brief.listTitle());
        String meta = brief.hasEssay || (data.modelEssayText != null && !data.modelEssayText.isEmpty())
                ? getString(R.string.ex_detail_has_model)
                : getString(R.string.ex_detail_no_model);
        b.edMeta.setText(meta);

        setSection(b.edDirections, b.edDirections, data.brief.directions);
        String prompt = brief.prompt == null ? "" : brief.prompt.trim();
        boolean promptDuplicate = prompt.equals(brief.directions == null ? "" : brief.directions.trim());
        boolean showPrompt = !prompt.isEmpty() && !promptDuplicate;
        Ui.show(b.edPromptLabel, showPrompt);
        Ui.show(b.edPrompt, showPrompt);
        if (showPrompt) b.edPrompt.setText(prompt);
        boolean showRequirements = data.requirements != null && !data.requirements.trim().isEmpty();
        Ui.show(b.edReqLabel, showRequirements);
        Ui.show(b.edRequirements, showRequirements);
        if (showRequirements) b.edRequirements.setText(data.requirements);

        boolean hasModel = data.modelEssayText != null && !data.modelEssayText.trim().isEmpty();
        b.edModel.setText(hasModel ? data.modelEssayText : getString(R.string.ex_detail_model_empty));
        b.edModelToggle.setEnabled(hasModel);
        b.edModelToggle.setVisibility(hasModel ? View.VISIBLE : View.GONE);

        b.edSources.removeAllViews();
        Ui.show(b.edSourcesCard, !data.sources.isEmpty());
        if (!data.sources.isEmpty()) {
            addLine(b.edSources, getString(R.string.ex_detail_sources), R.color.text_primary, true);
            for (String source : data.sources) addLine(b.edSources, source, R.color.text_secondary);
        }

        String image = brief.image;
        if (image != null && !image.isEmpty()) loadImage(image);
    }

    private void loadImage(String path) {
        if (imageReq != null) imageReq.cancel();
        imageReq = EeaApi.examImage(path, new ApiClient.Callback<byte[]>() {
            @Override
            public void onSuccess(byte[] data) {
                if (b == null || data == null) return;
                Bitmap bitmap = BitmapFactory.decodeByteArray(data, 0, data.length);
                if (bitmap == null) {
                    b.edImageNote.setText(R.string.ex_detail_image_failed);
                    Ui.show(b.edImageNote, true);
                    return;
                }
                b.edImage.setImageBitmap(bitmap);
                Ui.show(b.edImage, true);
            }

            @Override
            public void onFailure(ApiError error) {
                if (b == null) return;
                b.edImageNote.setText(getString(R.string.ex_detail_image_failed));
                Ui.show(b.edImageNote, true);
            }
        });
    }

    // ---------- 操作 ----------

    private String questionText() {
        if (detail == null) return "";
        Dto.ExamBrief brief = detail.brief;
        StringBuilder sb = new StringBuilder();
        if (brief.directions != null && !brief.directions.isEmpty()) sb.append(brief.directions);
        String prompt = brief.prompt == null ? "" : brief.prompt.trim();
        if (!prompt.isEmpty() && !prompt.equals(sb.toString().trim())) {
            sb.append(sb.length() > 0 ? "\n\n" : "").append(prompt);
        }
        if (detail.requirements != null && !detail.requirements.isEmpty()) {
            sb.append(sb.length() > 0 ? "\n\n" : "").append(detail.requirements);
        }
        return sb.toString().trim();
    }

    private void copyQuestion() {
        Context ctx = getContext();
        if (ctx == null) return;
        ClipboardManager cm = (ClipboardManager) ctx.getSystemService(Context.CLIPBOARD_SERVICE);
        if (cm == null) return;
        cm.setPrimaryClip(ClipData.newPlainText(getString(R.string.tab_exams), questionText()));
        Ui.toast(this, R.string.ex_detail_copy_done);
    }

    /** 带入写作：题干进输入框，原题图作为待分析图片，并记住 examId 供成文引用真题数据。 */
    private void practice() {
        if (detail == null) return;
        ComposeStore.question = questionText();
        ComposeStore.analysis = null;
        ComposeStore.pendingImage = null;
        ComposeStore.examId = detail.brief.id;
        String image = detail.brief.image;
        if (image == null || image.isEmpty()) {
            openWrite();
            return;
        }
        imageReq = EeaApi.examImage(image, new ApiClient.Callback<byte[]>() {
            @Override
            public void onSuccess(byte[] data) {
                if (!isAdded() || data == null) {
                    openWrite();
                    return;
                }
                Bitmap bitmap = BitmapFactory.decodeByteArray(data, 0, data.length);
                if (bitmap == null) {
                    Ui.toast(ExamDetailFragment.this, R.string.ex_detail_image_failed);
                    openWrite();
                    return;
                }
                java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
                bitmap.compress(Bitmap.CompressFormat.JPEG, 90, out);
                ComposeStore.pendingImage = "data:image/jpeg;base64,"
                        + android.util.Base64.encodeToString(out.toByteArray(), android.util.Base64.NO_WRAP);
                bitmap.recycle();
                Ui.toast(ExamDetailFragment.this, R.string.ex_practice_applied);
                openWrite();
            }

            @Override
            public void onFailure(ApiError error) {
                Ui.toast(ExamDetailFragment.this, R.string.ex_detail_image_failed);
                openWrite();
            }
        });
    }

    private void openWrite() {
        MainActivity activity = (MainActivity) getActivity();
        if (activity != null) activity.openTab(R.id.nav_write);
    }

    private void reviewWithExam() {
        if (detail == null) return;
        ReviewStore.useExam(detail.brief);
        Ui.toast(this, R.string.ex_review_applied);
        MainActivity activity = (MainActivity) getActivity();
        if (activity != null) activity.openTab(R.id.nav_review);
    }

    private void exportAnalysis() {
        if (detail == null) return;
        if (pdfReq != null) pdfReq.cancel();
        Ui.toast(this, R.string.ex_detail_pdf_busy);
        pdfReq = EeaApi.printAnalysis(detail.brief.id, true, new ApiClient.Callback<byte[]>() {
            @Override
            public void onSuccess(byte[] data) {
                if (!isAdded() || data == null || data.length == 0) return;
                Exports.shareBytes(requireActivity(), "行文精讲-" + detail.brief.id + ".pdf", data, "application/pdf");
                Ui.toast(ExamDetailFragment.this, R.string.ex_detail_pdf_ready);
            }

            @Override
            public void onFailure(ApiError error) {
                Ui.toast(ExamDetailFragment.this, getString(R.string.rr_pdf_failed, error.getMessage()));
            }
        });
    }

    // ---------- 排版 ----------

    private void setSection(TextView label, TextView body, String text) {
        boolean visible = text != null && !text.trim().isEmpty();
        Ui.show(label, visible);
        Ui.show(body, visible);
        if (visible) body.setText(text.trim());
    }

    private void addLine(LinearLayout parent, String text, int colorRes) {
        addLine(parent, text, colorRes, false);
    }

    private void addLine(LinearLayout parent, String text, int colorRes, boolean bold) {
        if (text == null || text.isEmpty()) return;
        TextView tv = new TextView(parent.getContext());
        tv.setText(text);
        tv.setTextSize(android.util.TypedValue.COMPLEX_UNIT_PX, getResources().getDimension(R.dimen.text_body));
        tv.setTextColor(ContextCompat.getColor(parent.getContext(), colorRes));
        tv.setLineSpacing(dp(3), 1f);
        if (bold) tv.setTypeface(null, android.graphics.Typeface.BOLD);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(2);
        parent.addView(tv, lp);
    }

    private int dp(int value) {
        return Math.round(getResources().getDisplayMetrics().density * value);
    }
}
