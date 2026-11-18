FROM python:3.13-slim
WORKDIR /app
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt && useradd --create-home appuser
COPY server.py /app/server.py
COPY public/ /app/public/
USER appuser
ENV HOST=0.0.0.0 PORT=8765
EXPOSE 8765
CMD ["python", "server.py"]
