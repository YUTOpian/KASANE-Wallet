import { useMemo, useState } from 'react';
import { Box, Button, Typography, Alert, LinearProgress } from '@mui/material';
import { useTranslation } from 'react-i18next';

const QUESTION_COUNT = 4;
const CHOICE_COUNT = 4;

interface Question {
  /** 0-based position in the phrase. */
  position: number;
  answer: string;
  choices: string[];
}

function shuffle<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Wrong choices come from the person's own phrase, so none can be ruled out as "not even in my phrase".
function buildQuestions(words: string[]): Question[] {
  const positions = shuffle(words.map((_, i) => i)).slice(0, QUESTION_COUNT).sort((a, b) => a - b);
  return positions.map((position) => {
    const answer = words[position];
    const others = shuffle([...new Set(words)].filter((w) => w !== answer)).slice(0, CHOICE_COUNT - 1);
    return { position, answer, choices: shuffle([answer, ...others]) };
  });
}

// Asks for a few words of the phrase by position. Any wrong pick sends the person back to the phrase, and the
// next attempt asks different positions, so the test cannot be passed by guessing.
export default function MnemonicQuiz({ words, onPass, onReview }: { words: string[]; onPass: () => void; onReview: () => void }) {
  const { t } = useTranslation();
  const questions = useMemo(() => buildQuestions(words), [words]);
  const [step, setStep] = useState(0);
  const [wrong, setWrong] = useState(false);

  const q = questions[step];

  const pick = (word: string) => {
    if (word !== q.answer) {
      setWrong(true);
      return;
    }
    if (step + 1 >= questions.length) onPass();
    else setStep(step + 1);
  };

  if (wrong) {
    return (
      <Box sx={{ mt: 3, px: 2 }}>
        <Alert severity="error">
          <Typography sx={{ fontWeight: 'bold' }}>{t('wallet.mnemonic_quiz_wrong_title')}</Typography>
          {t('wallet.mnemonic_quiz_wrong_message')}
        </Alert>
        <Box sx={{ display: 'flex', justifyContent: 'center', mt: 3 }}>
          <Button variant="contained" size="large" onClick={onReview} sx={{ minWidth: 200 }}>{t('wallet.mnemonic_quiz_review')}</Button>
        </Box>
      </Box>
    );
  }

  return (
    <Box sx={{ mt: 3, px: 2 }}>
      <Typography align="center" sx={{ color: 'text.secondary', fontSize: 13 }}>{t('wallet.mnemonic_quiz_intro')}</Typography>
      <Typography align="center" sx={{ mt: 3, color: 'text.secondary', fontSize: 13 }}>
        {t('wallet.mnemonic_quiz_progress', { current: step + 1, total: questions.length })}
      </Typography>
      <LinearProgress variant="determinate" value={(step / questions.length) * 100} sx={{ mt: 0.5, borderRadius: 1 }} />
      <Typography align="center" sx={{ mt: 3, fontWeight: 'bold', fontSize: 18 }}>
        {t('wallet.mnemonic_quiz_question', { index: q.position + 1 })}
      </Typography>
      <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1.5, mt: 3 }}>
        {q.choices.map((word) => (
          <Button key={word} variant="outlined" size="large" onClick={() => pick(word)} sx={{ textTransform: 'none', fontSize: 16 }}>
            {word}
          </Button>
        ))}
      </Box>
    </Box>
  );
}
