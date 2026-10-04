package cn.kaoyan.essay.ui;

import android.os.Bundle;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.fragment.app.Fragment;

import org.json.JSONArray;
import org.json.JSONObject;

import cn.kaoyan.essay.R;
import cn.kaoyan.essay.databinding.FragmentStudyAnalysisBinding;
import cn.kaoyan.essay.net.ApiClient;
import cn.kaoyan.essay.net.ApiError;
import cn.kaoyan.essay.net.Dto;
import cn.kaoyan.essay.net.EeaApi;
import cn.kaoyan.essay.util.Exports;

/**
 * 行文解析子页：挑一道真题，按段落看讲义模块与句子功能（可选 AI 深化讲解），可导出精讲 PDF。
 */
public class StudyAnalysisFragment extends Fragment {

    private FragmentStudyAnalysisBinding b;
    private ApiClient.Request analysisReq;
    private ApiClient.Request pdfReq;
    private String examId;
    private String examLabel;
    private boolean hasAnalysis;

    public StudyAnalysisFragment() {
        super(R.layout.fragment_study_analysis);
    }

    @Nullable
    @Override
    public View onCreateView(@NonNull LayoutInflater inflater, @Nullable ViewGroup container, @Nullable Bundle savedInstanceState) {
        b = FragmentStudyAnalysisBinding.inflate(inflater, container, false);
        return b.getRoot();
    }

    @Override
    public void onViewCreated(@NonNull View view, @Nullable Bundle savedInstanceState) {
        super.onViewCreated(view, savedInstanceState);
        b.saPick.setOnClickListener(v -> new ExamPickerDialog().show(getParentFragmentManager(), "study-exam-pick"));
        b.saPdf.setOnClickListener(v -> exportPdf());
        getParentFragmentManager().setFragmentResultListener(ExamPickerDialog.REQUEST_KEY, getViewLifecycleOwner(),
                (key, result) -> {
                    examId = result.getString(ExamPickerDialog.RESULT_ID);
                    examLabel = result.getString(ExamPickerDialog.RESULT_LABEL);
                    b.saExam.setText(examLabel);
                    analyze();
                });
    }

    @Override
    public void onDestroyView() {
        super.onDestroyView();
        if (analysisReq != null) analysisReq.cancel();
        if (pdfReq != null) pdfReq.cancel();
        b = null;
    }

    private void analyze() {
        if (examId == null || examId.isEmpty()) return;
        setBusy(true);
        if (analysisReq != null) analysisReq.cancel();
        analysisReq = EeaApi.analysisExam(examId, b.saAi.isChecked(), new ApiClient.Callback<Dto.Raw>() {
            @Override
            public void onSuccess(Dto.Raw data) {
                if (b == null) return;
                setBusy(false);
                hasAnalysis = true;
                b.saPdf.setEnabled(true);
                b.saBody.setTextColor(androidx.core.content.ContextCompat.getColor(requireContext(), R.color.text_primary));
                b.saBody.setText(render(data.json));
            }

            @Override
            public void onFailure(ApiError error) {
                if (b == null) return;
                setBusy(false);
                Ui.toast(StudyAnalysisFragment.this, getString(R.string.sa_failed, error.getMessage()));
            }
        });
    }

    /** 解析结果体 → 可读文本（只看稳定字段：轨道、段落模块、句子功能、AI 补充）。 */
    private String render(JSONObject data) {
        StringBuilder sb = new StringBuilder();
        JSONObject track = data.optJSONObject("track");
        if (track != null) append(sb, getString(R.string.review_track, track.optString("label", "")));
        JSONObject exam = data.optJSONObject("exam");
        if (exam != null && exam.optString("directions", "").length() > 0) {
            append(sb, exam.optString("directions"));
        }
        JSONObject insight = data.optJSONObject("aiInsight");
        if (insight != null) append(sb, insight.optString("summary", ""));
        JSONArray paragraphs = data.optJSONArray("paragraphs");
        if (paragraphs != null) {
            for (int i = 0; i < paragraphs.length(); i++) {
                JSONObject paragraph = paragraphs.optJSONObject(i);
                if (paragraph == null) continue;
                append(sb, "— " + paragraph.optString("name", getString(R.string.result_paragraph, i + 1)));
                JSONArray modules = paragraph.optJSONArray("modules");
                if (modules != null && modules.length() > 0) {
                    StringBuilder labels = new StringBuilder();
                    for (int j = 0; j < modules.length(); j++) {
                        JSONObject module = modules.optJSONObject(j);
                        if (module == null) continue;
                        if (labels.length() > 0) labels.append("、");
                        labels.append(module.optString("label", module.optString("id", "")));
                    }
                    append(sb, getString(R.string.sa_module, labels.toString(), paragraph.optInt("words", 0)));
                }
                JSONArray sentences = paragraph.optJSONArray("sentences");
                if (sentences == null) continue;
                for (int j = 0; j < sentences.length(); j++) {
                    JSONObject sentence = sentences.optJSONObject(j);
                    if (sentence == null) continue;
                    String text = sentence.optString("text", "");
                    String role = sentence.optString("roleLabel", "");
                    if (text.isEmpty()) continue;
                    append(sb, "· " + (role.isEmpty() ? "" : role + "：") + text);
                }
            }
        }
        JSONArray notes = data.optJSONArray("notes");
        if (notes != null) {
            for (int i = 0; i < notes.length(); i++) {
                String note = notes.optString(i, "");
                if (!note.isEmpty()) append(sb, getString(R.string.review_notes, note));
            }
        }
        return sb.length() == 0 ? getString(R.string.sa_empty) : sb.toString();
    }

    private void exportPdf() {
        if (!hasAnalysis || examId == null) {
            Ui.toast(this, R.string.sa_none);
            return;
        }
        if (pdfReq != null) pdfReq.cancel();
        Ui.toast(this, R.string.ex_detail_pdf_busy);
        pdfReq = EeaApi.printAnalysis(examId, b.saAi.isChecked(), new ApiClient.Callback<byte[]>() {
            @Override
            public void onSuccess(byte[] data) {
                if (!isAdded() || data == null || data.length == 0) return;
                Exports.shareBytes(requireActivity(), "行文精讲-" + examId + ".pdf", data, "application/pdf");
                Ui.toast(StudyAnalysisFragment.this, R.string.ex_detail_pdf_ready);
            }

            @Override
            public void onFailure(ApiError error) {
                Ui.toast(StudyAnalysisFragment.this, getString(R.string.rr_pdf_failed, error.getMessage()));
            }
        });
    }

    private void setBusy(boolean busy) {
        if (b == null) return;
        Ui.show(b.saProgress, busy);
        b.saPick.setEnabled(!busy);
        if (busy) b.saBody.setText(R.string.sa_busy);
    }

    private static void append(StringBuilder sb, String line) {
        if (line == null || line.isEmpty()) return;
        if (sb.length() > 0) sb.append('\n');
        sb.append(line);
    }
}
