FROM python:3.11-slim-bookworm
WORKDIR /app
COPY service/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt \
    && pip check \
    && python -c "from faster_whisper import WhisperModel"
COPY service/app.py /app/app.py
RUN useradd --uid 10001 --create-home soap && mkdir /models && chown soap:soap /models
USER soap
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--no-access-log"]
