2026年のGKE構築における「デファクトスタンダード」である**Autopilotモード**かつ**プライベートノード構成**のクラスターを作成するコマンドを回答します。

前回のネットワーク設定（Cloud NAT、VPC、サブネット）と組み合わせることで、**「外部からの攻撃対象領域を極小化しつつ、管理コストをほぼゼロにする」**構成が完成します。

### 1. GKE Autopilotクラスター作成コマンド

以下のコマンドを実行してください。2026年の推奨構成である「Autopilot」を選択することで、セキュリティ設定やDataplane V2などが自動的に適用されます。

**環境変数の設定（必要に応じて変更してください）**

```bash
export CLUSTER_NAME="osaka-region"
# コントロールプレーンとノード間の通信用内部IP（VPCと重複しない範囲）
export MASTER_IPV4_CIDR="172.16.0.16/28"
```

**クラスター作成コマンド**

```bash
gcloud container clusters create-auto $CLUSTER_NAME \
    --project=$PROJECT_ID \
    --region=$REGION \
    --network=$NETWORK_NAME \
    --subnetwork=$SUBNET_NAME \
    --cluster-secondary-range-name=pods-range \
    --services-secondary-range-name=services-range \
    --enable-private-nodes \
    --master-ipv4-cidr=$MASTER_IPV4_CIDR \
    --release-channel=regular
```

---

### 2. コマンドと構成の解説

このコマンドは、2026年のGKEベストプラクティス調査に基づき、以下の重要な設計思想を反映しています。

#### A. Autopilotモードの採用 (create-auto)

- **理由:** 2026年現在、GoogleはAutopilotを明確に推奨しています。ノードの管理、OSパッチ適用、スケーリングが完全にGoogle管理下になり、運用負担（Toil）が排除されます。
- **メリット:** スパイクアクセスがあっても、Podのリクエスト量に応じて自動でインフラが拡張されます。また、GPUが必要な場合も`Compute Classes`を指定するだけで利用可能です。

#### B. プライベートノードの有効化 (--enable-private-nodes)

- **理由:** ノードにパブリックIPアドレスを付与しない設定です。
- **NATとの連携:** 前段で作成した「Cloud NAT」があるため、ノードはインターネットから直接アクセスされることなく（セキュア）、必要な時だけNAT経由で外部へアクセスできます。これはゼロトラストセキュリティの基本です。

#### C. IPアドレス設計の適用 (--cluster-secondary-range-name)

- **理由:** 作成済みのサブネットの「セカンダリIP範囲」を明示的に指定しています。これにより、VPCネイティブクラスターとして構築され、Podのパフォーマンスが向上します。
- **キャパシティ:** `pods-range`（/16）を指定したため、IP枯渇を心配することなく数万Pod規模までスケール可能です。

#### D. コントロールプレーンのアクセス設定（デフォルト挙動）

- **設定:** 上記コマンドでは、コントロールプレーン（マスター）のパブリックエンドポイントは**有効**の状態で作られます。
- **意図:** 「社内ネットワークがない」という要件に基づき、お手元のPCやCI/CDツールから`kubectl`コマンドをインターネット経由で実行できるようにしています。
- **セキュリティ強化:** さらなるセキュリティが必要な場合は、`--master-authorized-networks`フラグを追加し、接続元のIP（自宅やオフィスのIP）のみを許可することを推奨します。

---

### 3. 作成後の接続確認

クラスター作成完了後（数分かかります）、以下のコマンドで接続設定を取得し、動作確認を行ってください。

```bash
# kubectlの設定を取得
gcloud container clusters get-credentials $CLUSTER_NAME \
    --region $REGION \
    --project $PROJECT_ID

# ノードの状態確認（すべてGoogle管理下のノードが表示されます）
kubectl get nodes
```

これで、**「管理不要（Autopilot）」**かつ**「セキュア（Private Nodes + NAT）」**な最新のGKE環境が整いました。
