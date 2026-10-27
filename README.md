
# ResearchFinderAI 🔎

**Discover Research Papers. Explore Ideas. Find Your Next Research Direction.**

ResearchFinderAI is an AI-assisted research discovery tool designed to help students, researchers, and academics explore research topics and discover relevant academic papers through a simple web interface.

Run ResearchFinderAI directly in **Google Colab** without manually setting up Python and Node.js on your local computer.

## ✨ Features

- **Research Discovery:** Explore academic papers related to your research interests.
- **AI-Assisted Analysis:** Use available AI features to help analyze research information.
- **Web Interface:** Access the application through a browser link generated in Google Colab.
- **Cloud-Based Setup:** Run the project in a Colab runtime without installing the complete development environment locally.

*Available features depend on the current project implementation and configuration.*

## 🎥 Project Video & Demo

## 🎥 ResearchFinderAI Demo

<p align="center">
  <a href="https://www.linkedin.com/feed/update/urn:li:ugcPost:7514804105626750976/" target="_blank">
    <img src="https://placehold.co/800x450/0A192F/FFFFFF?text=Watch+ResearchFinderAI+Demo"
         alt="Watch ResearchFinderAI Demo on LinkedIn"
         width="800">
  </a>
</p>

<p align="center">
  <a href="https://www.linkedin.com/feed/update/urn:li:ugcPost:7514804105626750976/">
    ▶️ Watch Full Demo on LinkedIn
  </a>
</p>

## 🚀 Getting Started with Google Colab

### Step 1: Open Google Colab

Open Google Colab:

https://colab.research.google.com/

Create a new notebook.

### Step 2: Enable GPU Runtime

To run ResearchFinderAI efficiently, enable GPU in Google Colab.

1. Click **Runtime** in the top menu.
2. Select **Change runtime type**.
3. Under **Hardware accelerator**, select **T4 GPU** (if available).
4. Click **Save**.

Now your notebook is configured to use a GPU, if one is assigned by Colab.

### Step 3: Verify GPU Availability

Run the following code in a notebook cell:

```python
!nvidia-smi
```

If a GPU is assigned, this command will display its details. GPU availability depends on your Colab plan and current resource limits.

> **⚠️ Note:** ResearchFinderAI can also run on a CPU, but **execution will be significantly slower than on a GPU.** For better performance, using a GPU runtime is recommended.

### Step 2: Clone and Run ResearchFinderAI

Copy the following code into a Colab cell and run it.

```python
!git clone https://github.com/mdmotalebmiraz7/ResearchFinderAI.git
%cd ResearchFinderAI
!bash run.sh
```

This downloads the repository and runs the startup script, which attempts to install dependencies and start the backend and frontend.

**Note:** The Colab runtime must have Python and Node.js/npm available. If startup fails, check the error output and the generated log files.

### Step 3: Open the Web Application

After the startup cell finishes, run this code in a **new Colab cell**:

```python
from google.colab.output import eval_js
from IPython.display import display, HTML

url = eval_js("google.colab.kernel.proxyPort(5173)")

display(HTML(f"""
<div style="text-align:center; margin:30px 0;">
    <a href="{url}" target="_blank"
       style="
           display:inline-block;
           font-size:25px;
           font-weight:bold;
           padding:22px 30px;
           background:#0d6efd;
           color:white;
           text-decoration:none;
           border-radius:14px;
       ">
       🚀 Launch ResearchFinderAI
    </a>
    <p style="font-size:16px; margin-top:12px;">
        Click the button above to open the research discovery application.
    </p>
</div>
"""))
```

Click **🚀 Launch ResearchFinderAI** to open the web interface.

The link is tied to your active Colab session. Keep the runtime running while using the application.

### Step 4: Configure AI Services (If Required)

If the application uses an external AI provider such as Groq, configure the required API key according to the project's backend instructions.

For Groq:

- Website: https://console.groq.com/
- API keys: https://console.groq.com/keys

Keep your API key private. Do not hardcode secrets in a public notebook or commit them to GitHub. Use Colab Secrets or environment variables as appropriate for your implementation.

## 🛠️ Troubleshooting

### The repository has already been cloned

If you run the cloning cell again in the same runtime, Git may report that the directory already exists. Use:

```python
%cd /content/ResearchFinderAI
!bash run.sh
```

### The web application does not open

Check whether the frontend started successfully:

```python
!cat frontend.log
```

### The backend is not responding

Check the backend log:

```python
!cat backend.log
```

### Dependency installation fails

Review the error output from `run.sh`. Confirm that the required packages are listed in `backend/requirements.txt` and that Node.js/npm is available.

### OpenAlex or another research API returns HTTP 429

This usually indicates rate limiting. The API request logic may need retry handling, request throttling, and correct pagination.

## ⚠️ Important Notes

- Google Colab runtimes are temporary and may disconnect.
- The application runs only while the required services and runtime remain active.
- Internet access is needed to clone the repository, install dependencies, and access external APIs.
- AI features may require API credentials and can be subject to provider usage limits.
- Do not upload private API keys or sensitive research data to a public repository.
- Actual functionality depends on the current implementation of ResearchFinderAI.

## 📜 Project Status

ResearchFinderAI is an evolving project. Features and setup instructions may change as development continues.

**GitHub Repository:** https://github.com/mdmotalebmiraz7/ResearchFinderAI

---

**ResearchFinderAI — Making research discovery more accessible.**
