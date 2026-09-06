import { useState } from "react";
import "./questions.css";
import { Button } from "./components";
import { CheckIcon, ClockIcon, SendIcon } from "./icons";
import type { InputRequest, InputQuestion } from "./types";
import type { JsonObject } from "../../../../../packages/protocol/src/models";
import { ElicitationCard } from "./ElicitationCard";

export function QuestionCard(props: { request: InputRequest; onSubmit: (answers: JsonObject) => Promise<void>; onLinkOpen?: ((url: string) => void) | undefined }) {
  return props.request.elicitation ? <ElicitationCard {...props} /> : <QuestionChoices {...props} />;
}

function QuestionChoices({ request, onSubmit }: { request: InputRequest; onSubmit: (answers: JsonObject) => Promise<void> }) {
  const questions: InputQuestion[] = request.questions ?? [{ id: request.answerKey, title: request.title, prompt: request.prompt,
    options: (request.options ?? []).map((label) => ({ value: label, label })), multiple: false, allowCustom: !request.options?.length, secret: false }];
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const answers = Object.fromEntries(questions.map((question) => [question.id,
    [...(selected[question.id] ?? []), ...(custom[question.id]?.trim() ? [custom[question.id]!.trim()] : [])],
  ]));
  return <details className="question-card" open>
    <summary><ClockIcon /><strong>Activity</strong><span>Question</span></summary>
    <form className="question-form" onSubmit={async (event) => {
      event.preventDefault();
      if (busy || questions.some((question) => !answers[question.id]?.length)) return;
      setBusy(true);
      setFailure(null);
      try { await onSubmit(answers); }
      catch (error) { setFailure(error instanceof Error ? error.message : String(error)); }
      finally { setBusy(false); }
    }}>
      {questions.map((question, index) => <fieldset key={question.id} disabled={busy}>
        <legend>{questions.length > 1 ? `${index + 1}. ` : ""}{question.title}</legend>
        <p>{question.prompt}</p>
        {question.multiple ? <small className="question-hint">Select all that apply</small> : null}
        {question.options.length ? <div className="question-options">{question.options.map((option) => {
          const checked = selected[question.id]?.includes(option.value) ?? false;
          return <label key={option.value} className={checked ? "selected" : ""}>
            <input type={question.multiple ? "checkbox" : "radio"} name={`${request.id}:${question.id}`} value={option.value} checked={checked} onChange={() => {
              setSelected((current) => ({ ...current, [question.id]: question.multiple
                ? checked ? (current[question.id] ?? []).filter((value) => value !== option.value) : [...(current[question.id] ?? []), option.value]
                : [option.value] }));
              if (!question.multiple) setCustom((current) => ({ ...current, [question.id]: "" }));
            }} />
            <span><strong>{option.label}</strong>{option.description ? <small>{option.description}</small> : null}
              {checked && option.preview ? <pre>{option.preview}</pre> : null}</span>
            {checked ? <CheckIcon /> : null}
          </label>;
        })}</div> : null}
        {question.allowCustom ? <label className="question-custom"><span>{question.options.length ? "Your own answer" : "Your answer"}</span>
          {question.secret ? <input type="password" autoComplete="off" value={custom[question.id] ?? ""} onChange={(event) => {
            setCustom((current) => ({ ...current, [question.id]: event.target.value }));
            if (!question.multiple && event.target.value) setSelected((current) => ({ ...current, [question.id]: [] }));
          }} />
            : <textarea rows={2} value={custom[question.id] ?? ""} placeholder="Type your answer…" onChange={(event) => {
              const value = event.target.value;
              setCustom((current) => ({ ...current, [question.id]: value }));
              if (!question.multiple && value) setSelected((current) => ({ ...current, [question.id]: [] }));
            }} />}</label> : null}
      </fieldset>)}
      {failure ? <p className="permission-error" role="alert">{failure}</p> : null}
      <div className="request-actions"><Button type="submit" variant="primary" disabled={busy || questions.some((question) => !answers[question.id]?.length)}>{busy ? "Sending…" : "Submit answer"}<SendIcon /></Button></div>
    </form>
  </details>;
}
