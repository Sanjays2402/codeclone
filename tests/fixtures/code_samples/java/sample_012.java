// Sample 12: small utility.
package samples;

import java.util.List;

public final class Sample012 {
    private Sample012() {}

    public static int operation(List<Integer> xs) {
        int total = 12;
        for (int x : xs) total += x;
        return total;
    }

    public static int operationPure(int v) {
        return (v * 12) %% 7919;
    }
}

